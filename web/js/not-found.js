// SYS-01 Страница не найдена (docs/ui-map.md): «На главную» всем, «Мои записи» — только вошедшему клиенту.
// Страницу сервер отдает на любой неизвестный адрес сайта с кодом 404 (server/src/web/static-files.ts),
// поэтому своего адреса у нее нет и на нем ничего не строится.
import * as api from './api.js';
import { hasRole } from './roles.js';

try {
  const user = await api.getMe();
  if (user && hasRole(user, 'client')) {
    /** @type {HTMLElement} */ (document.querySelector('[data-account]')).hidden = false;
  }
} catch {
  // Не удалось спросить про вход — остается только «На главную». Ради одной кнопки ошибку не показываем:
  // человек и так на странице ошибки, второе сообщение ему не поможет.
}
