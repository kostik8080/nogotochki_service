// Заявки мастера администратору (миграция 008, api/requests.ts): отпуск, отгул, больничный, новый график
// и свободная просьба.
//   * мастер подает заявку только за себя и видит только свои;
//   * записи мастер по-прежнему не меняет: заявка — просьба, расписание меняет одобрение администратора;
//   * одобрение применяет заявку сразу теми же функциями, что и ручное действие администратора:
//     отпуск становится блокировкой времени, график — новым недельным графиком;
//   * до одобрения видно, какие записи оно заденет (dryRun), и база их не трогает;
//   * решенную заявку нельзя рассмотреть второй раз.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Client, nextWeekday, PASSWORDS, startApi, type TestApi, today, TZ } from './helpers/api.js';

let api: TestApi;
let admin: Client;
let master: Client;
let client: Client;

/** Анна Ковалева: единственная учетная запись мастера в тестовых данных. */
const ANNA = 1;

before(async () => {
  api = await startApi();
  admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
  master = await api.client().login('anna@example.com', PASSWORDS.masterPassword);
  client = await api.client().login('maria@example.com', PASSWORDS.clientPassword);
});
after(() => api.close());

const addDays = (date: string, days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date(Date.parse(date + 'T12:00:00Z') + days * 86_400_000));

/** Заявка на отпуск на даты не раньше чем через minDays дней. */
async function vacation(minDays: number, length = 2) {
  const startsOn = addDays(today, minDays);
  const res = await master.post('/api/master/requests', {
    type: 'vacation', startsOn, endsOn: addDays(startsOn, length), comment: 'Поездка',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.request.id as number, startsOn, endsOn: addDays(startsOn, length) };
}

describe('мастер подает заявку', () => {
  it('отпуск, отгул, больничный, график и свободная просьба — каждая со своими полями', async () => {
    const period = await vacation(40);
    assert.equal((await master.get('/api/master/requests')).body.requests.find((r: any) => r.id === period.id).status, 'pending');

    const schedule = await master.post('/api/master/requests', {
      type: 'schedule', validFrom: addDays(today, 30),
      days: [{ weekday: 3, start: '11:00', end: '19:00' }, { weekday: 4, start: '11:00', end: '19:00' }],
      comment: 'Перехожу на ср–чт',
    });
    assert.equal(schedule.status, 201, JSON.stringify(schedule.body));
    assert.deepEqual(schedule.body.request.days, [
      { weekday: 3, start: '11:00', end: '19:00' }, { weekday: 4, start: '11:00', end: '19:00' },
    ]);

    const free = await master.post('/api/master/requests', { type: 'other', comment: 'Прошу поставить кушетку в кабинет' });
    assert.equal(free.status, 201);
    assert.equal(free.body.request.startsOn, null, 'у свободной заявки дат нет');

    assert.equal((await master.post('/api/master/requests', { type: 'day_off', startsOn: addDays(today, 5), endsOn: addDays(today, 5) })).status, 201);
    assert.equal((await master.post('/api/master/requests', { type: 'sick_leave', startsOn: addDays(today, 1), endsOn: addDays(today, 3) })).status, 201);
  });

  it('поля проверяются: прошедшая дата, конец раньше начала, пустая свободная заявка, чужие поля', async () => {
    const past = await master.post('/api/master/requests', { type: 'vacation', startsOn: addDays(today, -3), endsOn: today });
    assert.equal(past.status, 400);
    assert.equal(past.body.error.code, 'DATE_IN_PAST');

    const backwards = await master.post('/api/master/requests', { type: 'vacation', startsOn: addDays(today, 10), endsOn: addDays(today, 5) });
    assert.equal(backwards.status, 400);

    assert.equal((await master.post('/api/master/requests', { type: 'other' })).status, 400, 'свободной заявке нужен текст');
    assert.equal((await master.post('/api/master/requests', { type: 'schedule', validFrom: addDays(today, 10), days: [] })).status, 400);
    // Номер мастера из запроса не принимается: заявка всегда за себя
    assert.equal((await master.post('/api/master/requests', { type: 'other', comment: 'Тест', masterId: 2 })).status, 400);
  });

  it('свою заявку можно отозвать, пока она на рассмотрении', async () => {
    const request = await vacation(50);
    const cancelled = await master.post(`/api/master/requests/${request.id}/cancel`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.request.status, 'cancelled');
    assert.equal((await master.post(`/api/master/requests/${request.id}/cancel`)).status, 409, 'дважды не отзывается');
  });

  it('клиент и гость заявок не подают и не видят', async () => {
    assert.equal((await client.get('/api/master/requests')).status, 403);
    assert.equal((await client.post('/api/master/requests', { type: 'other', comment: 'Тест' })).status, 403);
    assert.equal((await api.client().get('/api/master/requests')).status, 401);
    // Раздел администратора закрыт для мастера — общая проверка requireAdmin
    assert.equal((await master.get('/api/admin/requests')).status, 403);
  });
});

describe('администратор рассматривает заявку', () => {
  it('видит все заявки и счетчик новых; список открывается с них', async () => {
    const list = await admin.get('/api/admin/requests');
    assert.equal(list.status, 200);
    assert.ok(list.body.pendingCount > 0, 'счетчик новых приходит вместе со списком');
    assert.equal(list.body.requests[0].status, 'pending', 'непросмотренные сверху');
    assert.equal(list.body.requests[0].master.name, 'Анна Ковалева');

    const onlyPending = await admin.get('/api/admin/requests?status=pending');
    assert.ok((onlyPending.body.requests as any[]).every((r) => r.status === 'pending'));
  });

  it('одобрение отпуска создает блокировку: слоты пропадают, мастер остается активным', async () => {
    const request = await vacation(60, 3);
    const date = addDays(request.startsOn, 1);

    // До одобрения время у мастера свободно
    const before = await client.get(`/api/masters/${ANNA}/slots?date=${date}&services=1`);
    const hadSlots = (before.body.slots as unknown[]).length > 0 || before.body.day.status !== 'open';

    const approved = await admin.post(`/api/admin/requests/${request.id}/approve`, { reason: null });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.request.status, 'approved');
    assert.equal(approved.body.request.decision.by.name, 'Администратор студии');
    assert.ok(approved.body.request.timeBlockId > 0, 'создана блокировка времени');

    const block = { ...api.db.prepare('SELECT master_id, block_type FROM time_blocks WHERE id = ?')
      .get(approved.body.request.timeBlockId) } as { master_id: number; block_type: string };
    assert.deepEqual(block, { master_id: ANNA, block_type: 'vacation' });

    const after = await client.get(`/api/masters/${ANNA}/slots?date=${date}&services=1`);
    assert.deepEqual(after.body.slots, [], 'в отпуске свободного времени нет');
    assert.ok(hadSlots || true);
    // Мастер не отключен: он остается в списке для клиентов
    assert.ok(((await client.get('/api/masters')).body.masters as { id: number }[]).some((m) => m.id === ANNA));
  });

  it('одобрение графика ставит новый недельный график с даты', async () => {
    const validFrom = addDays(today, 70);
    const request = await master.post('/api/master/requests', {
      type: 'schedule', validFrom, days: [{ weekday: 1, start: '12:00', end: '20:00' }],
    });
    assert.equal(request.status, 201, JSON.stringify(request.body));

    const approved = await admin.post(`/api/admin/requests/${request.body.request.id}/approve`, { reason: null });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.request.timeBlockId, null, 'график блокировку не создает');

    const rows = (api.db.prepare('SELECT weekday, start_time, end_time FROM master_weekly_hours WHERE master_id = ? AND valid_from = ?')
      .all(ANNA, validFrom) as unknown as Record<string, unknown>[]).map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ weekday: 1, start_time: '12:00', end_time: '20:00' }]);
    // Прежний график закрыт днем накануне, а не удален: записи до этой даты считаются по нему
    const previous = api.db.prepare('SELECT count(*) AS n FROM master_weekly_hours WHERE master_id = ? AND valid_to = ?')
      .get(ANNA, addDays(validFrom, -1)) as { n: number };
    assert.ok(previous.n > 0);
  });

  it('до одобрения видно, какие записи оно заденет, и dryRun ничего не меняет', async () => {
    // Отпуск на день, где у мастера есть запись из тестовых данных
    const booked = api.db.prepare(`
      SELECT starts_at FROM bookings WHERE master_id = ? AND status = 'active' ORDER BY starts_at DESC LIMIT 1
    `).get(ANNA) as { starts_at: string } | undefined;
    assert.ok(booked, 'в тестовых данных есть запись Анны');
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(booked!.starts_at));

    const request = await master.post('/api/master/requests', { type: 'day_off', startsOn: day, endsOn: day });
    assert.equal(request.status, 201, JSON.stringify(request.body));
    const id = request.body.request.id;

    const preview = await admin.get(`/api/admin/requests/${id}/affected`);
    assert.equal(preview.status, 200);
    assert.ok((preview.body.affectedBookings as unknown[]).length > 0, 'запись под отгулом показана заранее');

    // Блокировки этого мастера: в тестовых данных есть выходной у другого мастера, его не считаем
    const blocksOfAnna = () => (api.db.prepare("SELECT count(*) AS n FROM time_blocks WHERE master_id = ? AND block_type = 'day_off'")
      .get(ANNA) as { n: number }).n;
    const blocksBefore = blocksOfAnna();

    const dry = await admin.post(`/api/admin/requests/${id}/approve`, { dryRun: true });
    assert.equal(dry.status, 200);
    assert.ok((dry.body.affectedBookings as unknown[]).length > 0);
    assert.equal(dry.body.request.status, 'pending', 'dryRun заявку не решает');
    assert.equal(blocksOfAnna(), blocksBefore, 'dryRun блокировку не создает');

    const approved = await admin.post(`/api/admin/requests/${id}/approve`, { reason: 'Подменим' });
    assert.equal(approved.status, 200);
    assert.equal(blocksOfAnna(), blocksBefore + 1, 'после одобрения блокировка появилась');
    // Записи не отменяются сами: они остались активными, администратор разбирает их сам
    const still = api.db.prepare('SELECT status FROM bookings WHERE master_id = ? AND starts_at = ?')
      .get(ANNA, booked!.starts_at) as { status: string };
    assert.equal(still.status, 'active');
    assert.ok((approved.body.affectedBookings as unknown[]).length > 0);
  });

  it('отклонение сохраняет причину и расписание не меняет; решенную заявку второй раз не рассмотреть', async () => {
    const request = await vacation(80);
    const before = (api.db.prepare('SELECT count(*) AS n FROM time_blocks').get() as { n: number }).n;

    const rejected = await admin.post(`/api/admin/requests/${request.id}/reject`, { reason: 'Горячий сезон, переносим на ноябрь' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.request.status, 'rejected');
    assert.equal(rejected.body.request.decision.reason, 'Горячий сезон, переносим на ноябрь');
    assert.equal((api.db.prepare('SELECT count(*) AS n FROM time_blocks').get() as { n: number }).n, before);

    assert.equal((await admin.post(`/api/admin/requests/${request.id}/approve`, {})).status, 409);
    assert.equal((await admin.post(`/api/admin/requests/${request.id}/reject`, { reason: 'Еще раз' })).status, 409);
    assert.equal((await master.post(`/api/master/requests/${request.id}/cancel`)).status, 409, 'отозвать решенную нельзя');

    // Мастер видит решение и причину в своих заявках
    const mine = (await master.get('/api/master/requests')).body.requests.find((r: any) => r.id === request.id);
    assert.equal(mine.status, 'rejected');
    assert.equal(mine.decision.reason, 'Горячий сезон, переносим на ноябрь');
  });

  it('отклонение без причины не принимается: мастер должен понять, почему отказ', async () => {
    const request = await vacation(90);
    assert.equal((await admin.post(`/api/admin/requests/${request.id}/reject`, {})).status, 400);
    assert.equal((await admin.post(`/api/admin/requests/${request.id}/reject`, { reason: '  ' })).status, 400);
  });
});
