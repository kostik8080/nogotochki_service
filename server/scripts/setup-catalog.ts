// npm run setup:catalog (на сервере: npm run prod:setup:catalog) — заполняет каталог студии:
// категории, услуги, правила опции «Дизайн ногтей», несовместимые услуги и мастеров с их услугами
// и недельным графиком (src/db/catalog.ts). Это то же, что видно на локальной машине.
//
// Чем отличается от тестовых данных (npm run db:seed): здесь нет учетных записей, клиентов, записей
// и фото — на работающем сервере им не место. Поэтому команду можно выполнять и в production.
//
// Команда повторяемая: добавляется только то, чего в базе еще нет. Цены и названия, которые
// администратор поправил в панели, она не возвращает к исходным.
//
// Режим технических работ команда не трогает: студия выключает его сама, когда готова принимать
// клиентов (PATCH /api/admin/settings с isMaintenance: false).
import { config } from '../src/config.js';
import { seedCatalog } from '../src/db/catalog.js';
import { openDatabase } from '../src/db/connection.js';
import { pendingMigrations } from '../src/db/migrator.js';

const db = openDatabase();
try {
  const pending = pendingMigrations(db);
  if (pending.length > 0) {
    throw new Error(`В базе не применены миграции: ${pending.join(', ')}. Запустите сервер — он применит их сам, либо выполните db:migrate`);
  }

  const report = seedCatalog(db);
  console.log(`Каталог студии: ${config.databasePath}\n`);
  console.log(`${'Таблица'.padEnd(28)}${'добавлено'.padStart(10)}${'уже было'.padStart(10)}`);
  let created = 0;
  for (const [table, stat] of report) {
    console.log(`${table.padEnd(28)}${String(stat.created).padStart(10)}${String(stat.existing).padStart(10)}`);
    created += stat.created;
  }
  console.log(created > 0
    ? '\nГотово. Проверьте услуги и мастеров в разделе администратора и выключите режим технических работ, когда будете готовы принимать клиентов.'
    : '\nВсе уже было в базе — ничего не добавлено.');
} finally {
  db.close();
}
