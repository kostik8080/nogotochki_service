// Адреса клиентских страниц. Один экран карты (docs/ui-map.md) — одна страница в web/ (docs/frontend-rules.md,
// правило 2). Имя файла повторяет маршрут прототипа: #/booking/services → booking-services.html.
// Страницы, которых еще нет, сверстаются под этими же адресами.

export const routes = {
  /** PUB-01 Лендинг */
  home: 'index.html',
  /** AUTH-01 Вход */
  login: 'login.html',
  /** AUTH-03 Регистрация; подтверждение кодом (AUTH-02) — шаг этой же страницы */
  register: 'register.html',
  /** AUTH-06 Восстановление пароля */
  forgotPassword: 'forgot-password.html',
  /** AUTH-08 Новый пароль. Ссылка из письма ведет на /reset-password?token=… — без .html, это решает веб-сервер */
  resetPassword: 'reset-password.html',
  /** AUTH-04 Вход сотрудника — вне карты клиентских экранов */
  staffLogin: 'staff-login.html',
  /** CAB-01 Мои записи */
  account: 'account.html',
  /** CAB-02 История */
  history: 'history.html',
  /** CAB-07 Профиль */
  profile: 'profile.html',
  /** Политика обработки персональных данных — в карте экранов нет */
  privacy: 'privacy.html',

  /**
   * BOOK-01 Шаг 1. Услуги. `service` — услуга, которая сразу попадет в корзину;
   * `master` — закрепленный мастер («Записаться к мастеру»).
   * @param {{ service?: number, master?: number }} [preset]
   */
  booking(preset = {}) {
    const query = new URLSearchParams();
    if (preset.service !== undefined) query.set('service', String(preset.service));
    if (preset.master !== undefined) query.set('master', String(preset.master));
    const qs = query.toString();
    return 'booking-services.html' + (qs ? '?' + qs : '');
  },

  /** BOOK-03 Шаг 3. Время (выбор уже в черновике записи, js/store.js) */
  bookingTimeStep: 'booking-time.html',
  /** BOOK-04 Шаг 4. Подтверждение */
  bookingConfirm: 'booking-confirm.html',
  /** BOOK-05 Вы записаны — по номеру созданной записи */
  bookingSuccess: (id) => 'booking-success.html?id=' + encodeURIComponent(String(id)),

  /**
   * BOOK-02 Шаг 2. Мастер — с уже выбранными услугами.
   * @param {string} services услуги в формате API: «8,3:2» — номера через запятую, количество через двоеточие
   */
  bookingMaster: (services) => 'booking-master.html?services=' + encodeURIComponent(services),

  /**
   * BOOK-03 Шаг 3. Время — с услугами и мастером («Повторить визит»).
   * @param {{ services: string, master?: number }} preset
   */
  bookingTime(preset) {
    const query = new URLSearchParams({ services: preset.services });
    if (preset.master !== undefined) query.set('master', String(preset.master));
    return 'booking-time.html?' + query.toString();
  },

  /** PUB-05 Профиль мастера */
  master: (id) => 'master.html?id=' + encodeURIComponent(String(id)),

  /**
   * CAB-03 Карточка записи. `cancel` — сразу открыть окно отмены (CAB-05 — модалка на карточке).
   * @param {number} id
   * @param {{ cancel?: boolean }} [options]
   */
  bookingCard: (id, options = {}) => 'booking.html?id=' + encodeURIComponent(String(id)) + (options.cancel ? '&cancel=1' : ''),

  /** CAB-04 Перенос записи — экран выбора времени в режиме переноса: услуги и мастер из записи */
  reschedule: (id) => 'booking-time.html?reschedule=' + encodeURIComponent(String(id)),
};
