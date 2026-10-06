// Отдача клиентского интерфейса из web/ самим сервером (src/web/static-files.ts): сервис работает
// одним процессом, и на сервере перед ним остается только HTTPS.
// Главное, что здесь проверяется, — чего сервер отдавать НЕ должен: файлы разделов сотрудников
// и что-либо за пределами папки web/.
import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { startApi, type TestApi } from './helpers/api.js';

let api: TestApi;
before(async () => {
  api = await startApi();
});
after(() => api.close());

it('отдает страницы и файлы интерфейса', async () => {
  const client = api.client();

  const home = await client.get('/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(String(home.body), /Ноготочки/);
  // Страницы интерфейса меняются вместе с кодом, поэтому браузер каждый раз проверяет, не изменились ли они.
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');

  assert.equal((await client.get('/login.html')).status, 200);
  assert.equal((await client.get('/index.html')).status, 200);

  const css = await client.get('/css/base.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');

  const js = await client.get('/js/api.js');
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');

  // Ссылка из письма ведет на адрес без .html — это та же страница (docs/ui-map.md, список 1, пункт 10.2).
  const reset = await client.get('/reset-password?token=test');
  assert.equal(reset.status, 200);
  assert.match(String(reset.body), /Новый пароль/);
});

it('не отдает файлами разделы сотрудников — ни одним написанием адреса', async () => {
  const client = api.client();
  // Прямой адрес разбирает src/web/admin-pages.ts: гостя он уводит на вход, а не показывает разметку.
  const direct = await client.get('/admin/bookings.html');
  assert.ok(direct.status === 302 || direct.status === 404, `статус ${direct.status}`);
  assert.doesNotMatch(String(direct.body), /<table|шахматк/i);

  // Другой регистр и процентное кодирование не должны обойти проверку роли.
  for (const path of ['/Admin/bookings.html', '/%61dmin/bookings.html', '/master/schedule.html', '/MASTER/schedule.html']) {
    const res = await client.get(path);
    assert.ok(res.status === 302 || res.status === 403 || res.status === 404, `${path}: статус ${res.status}`);
    assert.doesNotMatch(String(res.body), /<!DOCTYPE html>\s*<html lang="ru">[\s\S]*data-bookings/i, path);
  }
});

it('не выпускает за пределы папки web/', async () => {
  const client = api.client();
  for (const path of ['/../server/.env', '/..%2fserver%2f.env', '/%2e%2e/package.json', '/..\\server\\.env']) {
    const res = await client.get(path);
    assert.notEqual(res.status, 200, `${path}: отдан файл за пределами web/`);
  }
});

it('неизвестный адрес сайта — экран «Страница не найдена», а не ответ API', async () => {
  const client = api.client();

  for (const path of ['/takogo-net', '/takogo-net.html', '/kakaya-to/glubokaya/stranica']) {
    const res = await client.get(path);
    assert.equal(res.status, 404, `${path}: ожидали 404`);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8', `${path}: ожидали страницу`);
    assert.match(String(res.body), /Страница не найдена/, `${path}: нет текста страницы`);
    assert.doesNotMatch(String(res.body), /"error"/, `${path}: в ответе остался JSON API`);
  }

  // Картинка или стиль — обычный 404 без разметки: в теге <img> страница все равно не покажется.
  const asset = await client.get('/img/takogo-net.png');
  assert.equal(asset.status, 404);
  assert.doesNotMatch(String(asset.body ?? ''), /Страница не найдена/);

  // Адреса API остаются ответом API (проверка ниже), а выход за папку web/ — тоже 404 и без файла.
  const outside = await client.get('/../server/.env');
  assert.equal(outside.status, 404);
  assert.doesNotMatch(String(outside.body ?? ''), /SMTP_/);
});

it('адреса API отдачей файлов не перехватываются', async () => {
  const client = api.client();
  const unknown = await client.get('/api/takogo-net');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'NOT_FOUND');

  // Витрина по-прежнему отвечает JSON, а не файлом.
  const studio = await client.get('/api/studio');
  assert.equal(studio.status, 200);
  assert.ok(studio.body.studio ?? studio.body.name ?? studio.body.timezone, 'ответ /api/studio не похож на JSON витрины');
});
