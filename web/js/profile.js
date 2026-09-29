// CAB-07 Профиль и CAB-10 Удаление аккаунта (docs/ui-map.md). Три вкладки: «Личные данные» (имя, телефон, e-mail),
// «Безопасность» (пароль, выход, удаление аккаунта), «Уведомления» (что сообщает сервис, рассылка). Данные: GET /api/auth/me
// (name, phone, email, emailVerified, marketingConsent), GET /api/studio — телефон студии в подсказке.
//   Имя → PATCH /api/profile { name }; согласие на новости → PATCH /api/profile { marketingConsent } сразу по флажку;
//   новый e-mail и «Подтвердить» у неподтвержденного → POST /api/profile/email { email } → код в окне AUTH-02
//     → POST /api/profile/email/confirm { code }; до кода в профиле остается прежний адрес;
//   смена пароля → POST /api/profile/password: 204 — остальные сессии закрыты, 403 WRONG_PASSWORD;
//   «Выйти» → POST /api/auth/logout; «Удалить аккаунт» → DELETE /api/profile { password } → главная.
// Телефон только для чтения: номер меняет администратор (пункт 11.2 карты). Без входа — на вход с возвратом сюда.
import * as api from './api.js';
import {
  bindPasswordHints, clearErrors, clearOnInput, isEmail, passwordError, retryText, setBusy, setFieldError,
  showAlert, showErrors, showServerError,
} from './form.js';
import { phone as formatPhone, phoneHref, plural } from './format.js';
import { updateAccountName } from './header.js';
import { routes } from './routes.js';

const RESEND_SECONDS = 60;

const $ = (selector, root = document) => /** @type {any} */ (root.querySelector(selector));
const input = (form, name) => /** @type {HTMLInputElement} */ (form.elements.namedItem(name));

const views = {
  loading: $('[data-view="loading"]'),
  error: $('[data-view="error"]'),
  content: $('[data-view="content"]'),
};

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

const goLogin = () => window.location.replace(`${routes.login}?next=${encodeURIComponent(routes.profile)}`);
const isAuthError = (error) => error instanceof api.ApiError && error.status === 401;

/** Пользователь, как его вернул сервер последним ответом. */
let user = null;

// ---------- Вкладки: «Личные данные», «Безопасность», «Уведомления» ----------
// Открытая вкладка — в адресе (#security, #notifications): ее можно открыть ссылкой, она переживает перезагрузку.

const tabs = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('[role="tab"]')]);
const tabNames = tabs.map((tab) => tab.dataset.tab);

/**
 * @param {string} name personal | security | notifications
 * @param {{ focus?: boolean }} [options] focus — перевести фокус на вкладку (выбор с клавиатуры)
 */
function selectTab(name, { focus = false } = {}) {
  const current = tabNames.includes(name) ? name : tabNames[0];
  for (const tab of tabs) {
    const selected = tab.dataset.tab === current;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    /** @type {HTMLElement} */ (document.getElementById(tab.getAttribute('aria-controls'))).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  const hash = current === tabNames[0] ? '' : `#${current}`;
  if (window.location.hash !== hash) history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
}

const hashTab = () => window.location.hash.slice(1);

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  // Стрелки переключают вкладки: вправо-влево в строке, вверх-вниз в колонке
  tab.addEventListener('keydown', (event) => {
    const i = tabs.indexOf(tab);
    const next = {
      ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: tabs.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(tabs[(next + tabs.length) % tabs.length].dataset.tab, { focus: true });
  });
}

// «Настройки уведомлений» в колокольчике, когда профиль уже открыт
window.addEventListener('hashchange', () => selectTab(hashTab()));
selectTab(hashTab());

// ---------- Личные данные ----------

const nameForm = /** @type {HTMLFormElement} */ ($('[data-name-form]'));
const nameAlert = $('[data-alert]', nameForm);
const nameSave = /** @type {HTMLButtonElement} */ ($('[data-name-save]'));

function renderUser() {
  input(nameForm, 'name').value = user.name;
  nameSave.disabled = true;

  $('[data-phone]').textContent = user.phone ? formatPhone(user.phone) : 'Не указан';

  const email = $('[data-email]');
  email.textContent = user.email ?? 'Не указан';
  email.classList.toggle('profile-value--empty', !user.email);
  $('[data-email-unverified]').hidden = !user.email || user.emailVerified;
  $('[data-email-verify]').hidden = !user.email || user.emailVerified;
  $('[data-email-edit]').textContent = user.email ? 'Изменить' : 'Добавить';

  $('[data-marketing]').checked = user.marketingConsent;
  $('[data-marketing-hint]').textContent = user.email
    ? 'Согласие можно отозвать в любой момент — снимите флажок.'
    : 'Письма приходят на e-mail, а он не указан. Добавьте его во вкладке «Личные данные».';
}

clearOnInput(nameForm);
nameForm.addEventListener('input', () => {
  nameSave.disabled = input(nameForm, 'name').value.trim() === user.name;
  nameAlert.hidden = true;
});

nameForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(nameForm, nameAlert);
  const name = input(nameForm, 'name').value.trim();
  if (!showErrors(nameForm, { name: name ? null : 'Как к вам обращаться?' })) return;

  const done = setBusy(nameSave, 'Сохраняем…');
  try {
    user = await api.updateProfile({ name });
    done();
    renderUser();
    updateAccountName(user.name);
    showAlert(nameAlert, 'success', 'Имя сохранено.');
  } catch (error) {
    done();
    if (isAuthError(error)) return goLogin();
    showServerError(nameForm, nameAlert, error);
  }
});

/** Подсказка у телефона — с номером студии, если он загрузился. */
async function loadStudioPhone() {
  try {
    const studio = await api.getStudio();
    const hint = $('[data-phone-hint]');
    const link = document.createElement('a');
    link.className = 'text-link';
    link.href = phoneHref(studio.phone);
    link.textContent = formatPhone(studio.phone);
    hint.replaceChildren('Сменить номер можно через студию: ', link);
  } catch {
    // Остается подсказка без номера: телефон студии есть на главной
  }
}

// ---------- Согласие на новости: сохраняется сразу по флажку ----------

const marketing = /** @type {HTMLInputElement} */ ($('[data-marketing]'));
const marketingStatus = $('[data-marketing-status]');

marketing.addEventListener('change', async () => {
  const wanted = marketing.checked;
  marketing.disabled = true;
  marketingStatus.className = 'profile-status';
  marketingStatus.textContent = 'Сохраняем…';
  try {
    user = await api.updateProfile({ marketingConsent: wanted });
    marketingStatus.textContent = wanted ? 'Вы подписаны на новости.' : 'Вы отписались от новостей.';
  } catch (error) {
    if (isAuthError(error)) return goLogin();
    marketing.checked = !wanted;
    marketingStatus.className = 'profile-status profile-status--error';
    marketingStatus.textContent = `Не удалось сохранить. ${error instanceof api.ApiError ? error.message : ''}`.trim();
  } finally {
    marketing.disabled = false;
  }
});

// ---------- E-mail: новый адрес или подтверждение текущего ----------

const emailView = $('[data-email-view]');
const emailForm = /** @type {HTMLFormElement} */ ($('[data-email-form]'));
const emailAlert = $('[data-email-alert]');

function openEmailForm() {
  emailAlert.hidden = true;
  clearErrors(emailForm);
  input(emailForm, 'email').value = '';
  emailView.hidden = true;
  emailForm.hidden = false;
  input(emailForm, 'email').focus();
}

function closeEmailForm() {
  emailForm.hidden = true;
  emailView.hidden = false;
  $('[data-email-edit]').focus();
}

$('[data-email-edit]').addEventListener('click', openEmailForm);
$('[data-email-cancel]').addEventListener('click', closeEmailForm);
clearOnInput(emailForm);

/** Текст ошибки отправки кода: 429 — когда можно повторить, остальное — текстом сервера. */
function codeRequestError(error) {
  if (!(error instanceof api.ApiError)) return 'Что-то пошло не так. Обновите страницу и попробуйте еще раз.';
  return error.status === 429 ? `${error.message}. ${retryText(error.retryAfter)}` : error.message;
}

emailForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(emailForm);
  const email = input(emailForm, 'email').value.trim().toLowerCase();
  const error = !email ? 'Введите новый e-mail'
    : !isEmail(email) ? 'Проверьте e-mail: например, name@example.com'
      : email === user.email && user.emailVerified ? 'Этот адрес уже подтвержден' : null;
  if (!showErrors(emailForm, { email: error })) return;

  const done = setBusy(/** @type {HTMLButtonElement} */ ($('[type=submit]', emailForm)), 'Отправляем…');
  try {
    const result = await api.requestEmailCode({ email });
    done();
    emailForm.hidden = true;
    emailView.hidden = false;
    openCodeDialog(email, result);
  } catch (err) {
    done();
    if (isAuthError(err)) return goLogin();
    if (err instanceof api.ApiError && (err.code === 'EMAIL_TAKEN' || err.status === 400)) {
      setFieldError(emailForm, 'email', err.fields[0]?.message ?? err.message);
      input(emailForm, 'email').focus();
    } else {
      setFieldError(emailForm, 'email', codeRequestError(err));
    }
  }
});

// «Подтвердить» у неподтвержденного адреса: код на тот же адрес
const verifyButton = /** @type {HTMLButtonElement} */ ($('[data-email-verify]'));
verifyButton.addEventListener('click', async () => {
  emailAlert.hidden = true;
  const done = setBusy(verifyButton, 'Отправляем…');
  try {
    const result = await api.requestEmailCode({ email: user.email });
    done();
    openCodeDialog(user.email, result);
  } catch (error) {
    done();
    if (isAuthError(error)) return goLogin();
    showAlert(emailAlert, 'error', codeRequestError(error));
  }
});

// ---------- Окно кода из письма (AUTH-02) ----------

const codeDialog = /** @type {HTMLDialogElement} */ ($('[data-code-dialog]'));
const codeForm = /** @type {HTMLFormElement} */ ($('[data-code-form]'));
const codeAlert = $('[data-alert]', codeForm);
const resendButton = /** @type {HTMLButtonElement} */ ($('[data-resend]'));

/** Адрес, на который ушел последний код: живет только до перезагрузки страницы. */
let pendingEmail = null;
let resendTimer = 0;

function openCodeDialog(email, result) {
  pendingEmail = email;
  const minutes = result.expiresInMin;
  $('[data-code-hint]').textContent =
    `Код отправлен на ${result.sentTo}, действует ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}.`;
  input(codeForm, 'code').value = '';
  clearErrors(codeForm, codeAlert);
  if (!codeDialog.open) codeDialog.showModal();
  input(codeForm, 'code').focus();
  startResendTimer();
}

function startResendTimer() {
  clearInterval(resendTimer);
  let left = RESEND_SECONDS;
  const tick = () => {
    resendButton.disabled = left > 0;
    resendButton.textContent = left > 0 ? `Отправить код повторно через ${left} с` : 'Отправить код повторно';
    left -= 1;
    if (left < 0) clearInterval(resendTimer);
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

codeDialog.addEventListener('close', () => clearInterval(resendTimer));
$('[data-code-close]').addEventListener('click', () => codeDialog.close());
$('[data-code-change]').addEventListener('click', () => {
  codeDialog.close();
  openEmailForm();
});
clearOnInput(codeForm);

codeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(codeForm, codeAlert);
  const code = input(codeForm, 'code').value.replace(/\s/g, '');
  if (!showErrors(codeForm, { code: /^\d{6}$/.test(code) ? null : 'Введите 6 цифр из письма' })) return;

  const done = setBusy(/** @type {HTMLButtonElement} */ ($('[type=submit]', codeForm)), 'Проверяем…');
  try {
    user = await api.confirmEmailCode({ code });
    done();
    codeDialog.close();
    renderUser();
    showAlert(emailAlert, 'success', 'E-mail подтвержден.');
  } catch (error) {
    done();
    if (isAuthError(error)) return goLogin();
    if (error instanceof api.ApiError && error.code === 'INVALID_CODE') {
      const left = /** @type {any} */ (error.details)?.attemptsLeft;
      const message = typeof left === 'number' && left > 0
        ? `Неверный код. ${plural(left, 'Осталась', 'Осталось', 'Осталось')} ${left} ${plural(left, 'попытка', 'попытки', 'попыток')}.`
        : error.message;
      showErrors(codeForm, { code: message });
    } else {
      showServerError(codeForm, codeAlert, error);
    }
  }
});

resendButton.addEventListener('click', async () => {
  clearErrors(codeForm, codeAlert);
  const done = setBusy(resendButton, 'Отправляем…');
  try {
    const result = await api.requestEmailCode({ email: pendingEmail });
    done();
    openCodeDialog(pendingEmail, result);
    showAlert(codeAlert, 'success', 'Новый код отправлен.');
  } catch (error) {
    done();
    if (isAuthError(error)) return goLogin();
    showAlert(codeAlert, 'error', codeRequestError(error));
  }
});

// ---------- Смена пароля ----------

const passwordForm = /** @type {HTMLFormElement} */ ($('[data-password-form]'));
const passwordAlert = $('[data-alert]', passwordForm);

bindPasswordHints(input(passwordForm, 'newPassword'), $('[data-password-rules]', passwordForm));
clearOnInput(passwordForm);

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(passwordForm, passwordAlert);
  const currentPassword = input(passwordForm, 'currentPassword').value;
  const newPassword = input(passwordForm, 'newPassword').value;
  const repeat = input(passwordForm, 'repeatPassword').value;
  const valid = showErrors(passwordForm, {
    currentPassword: currentPassword ? null : 'Введите текущий пароль',
    newPassword: passwordError(newPassword) ?? (newPassword === currentPassword ? 'Новый пароль совпадает с текущим' : null),
    repeatPassword: !repeat ? 'Повторите новый пароль' : repeat !== newPassword ? 'Пароли не совпадают' : null,
  });
  if (!valid) return;

  const done = setBusy(/** @type {HTMLButtonElement} */ ($('[type=submit]', passwordForm)), 'Сохраняем…');
  try {
    await api.changePassword({ currentPassword, newPassword });
    done();
    passwordForm.reset();
    input(passwordForm, 'newPassword').dispatchEvent(new Event('input'));
    showAlert(passwordAlert, 'success', 'Пароль изменен. На других устройствах нужно будет войти заново.');
  } catch (error) {
    done();
    if (isAuthError(error)) return goLogin();
    if (error instanceof api.ApiError && error.code === 'WRONG_PASSWORD') {
      showErrors(passwordForm, { currentPassword: 'Неверный текущий пароль' });
    } else {
      showServerError(passwordForm, passwordAlert, error);
    }
  }
});

// ---------- Выйти ----------

const logoutButton = /** @type {HTMLButtonElement} */ ($('[data-logout]'));
logoutButton.addEventListener('click', async () => {
  const errorBox = $('[data-logout-error]');
  errorBox.hidden = true;
  logoutButton.disabled = true;
  try {
    await api.logout();
    window.location.assign(routes.home);
  } catch (error) {
    errorBox.textContent = `Не удалось выйти. ${error.message}`;
    errorBox.hidden = false;
    logoutButton.disabled = false;
  }
});

// ---------- Удаление аккаунта (CAB-10) ----------

const deleteDialog = /** @type {HTMLDialogElement} */ ($('[data-delete-dialog]'));
const deleteForm = /** @type {HTMLFormElement} */ ($('[data-delete-form]'));
const deleteAlert = $('[data-alert]', deleteForm);

$('[data-delete-open]').addEventListener('click', () => {
  deleteForm.reset();
  clearErrors(deleteForm, deleteAlert);
  deleteDialog.showModal();
  input(deleteForm, 'password').focus();
});
$('[data-delete-close]').addEventListener('click', () => deleteDialog.close());
clearOnInput(deleteForm);

deleteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(deleteForm, deleteAlert);
  const password = input(deleteForm, 'password').value;
  if (!showErrors(deleteForm, { password: password ? null : 'Введите пароль' })) return;

  const done = setBusy(/** @type {HTMLButtonElement} */ ($('[type=submit]', deleteForm)), 'Удаляем…');
  try {
    await api.deleteAccount({ password });
    window.location.replace(routes.home);
  } catch (error) {
    done();
    if (isAuthError(error)) return goLogin();
    if (error instanceof api.ApiError && error.code === 'WRONG_PASSWORD') {
      showErrors(deleteForm, { password: 'Неверный пароль' });
    } else {
      showServerError(deleteForm, deleteAlert, error);
    }
  }
});

// ---------- Загрузка ----------

async function load() {
  show('loading');
  try {
    user = await api.getMe();
    if (!user) return goLogin();
    if (user.role !== 'client') return window.location.replace(routes.home);
    renderUser();
    show('content');
    loadStudioPhone();
  } catch (error) {
    $('[data-error-text]').textContent = error instanceof api.ApiError ? error.message : 'Что-то пошло не так. Обновите страницу.';
    show('error');
  }
}

$('[data-retry]').addEventListener('click', load);
load();
