# Журнал подключения клиентских экранов

Что сверстано в `web/` к 29.09.2026 и откуда каждый экран берет данные. Составлено по коду `web/js/`, истории коммитов `bc1f69a`, `6651506`, `c26f72e`, `ab65e77` и отчетам сессий верстки 27–29.09.2026. ID и маршруты экранов — из [ui-map.md](ui-map.md) и прототипа `Prototype/Прототип - Ноготочки.dc.html`.

Все запросы идут через `web/js/api.js`. Ошибку API любой экран показывает текстом из `error.message`, а формы подсвечивают поля из `error.details.fields` (`js/form.js`). Время приходит в UTC и выводится в часовом поясе студии `timezone` из `GET /api/studio`, деньги — из копеек (`…Kop`).

## Общее для всех страниц

| Что | Файл | Эндпоинты | Поля ответа |
|---|---|---|---|
| Шапка `<client-header>`: логотип, «Записаться», меню аккаунта или «Войти» и «Регистрация». Стоит на всех страницах, кроме лендинга | `js/header.js`, `css/header.css` | `GET /api/auth/me` (один запрос на страницу), «Выйти» — `POST /api/auth/logout` | `user.name` (имя и инициалы), `user.role` (клиенту — «Мои записи» и «Профиль», сотруднику — только «Выйти») |
| Колокольчик в шапке клиента: сообщения студии и напоминания за сутки, 2 часа и 15 минут до визита | `js/notifications.js` | `GET /api/bookings`, `GET /api/studio`; ✕ у сообщения студии — `POST /api/bookings/:id/acknowledge` | записи: `id`, `status`, `startsAt`, `studioChange.type`, `items[].name`, `items[].quantity`, `master.name`; студия: `timezone`, `address` |
| Меню кабинета `<cabinet-nav>`: «Мои записи», «История», «Профиль», «Выйти» | `js/cabinet-nav.js`, `css/cabinet.css` | «Выйти» — `POST /api/auth/logout` | — |

## Лендинг

**PUB-01 Лендинг** — `Prototype/Лендинг - Ноготочки.dc.html`
* **Файл:** `web/index.html`, `js/landing.js`, `css/landing.css`.
* **Показывает:** первый экран, цифры, «Как это работает» со сроком правила отмены, услуги с ценой «от», мастеров, три работы из галереи, контакты и режим работы, подвал. В шапке — «Войти» и «Регистрация» или меню клиента с колокольчиком.
* **Эндпоинты:** `GET /api/auth/me`, `GET /api/studio`, `GET /api/services`, `GET /api/masters`, `GET /api/gallery?limit=3`, картинки — `GET /api/photos/:id/file` (адрес из `url`), «Выйти» — `POST /api/auth/logout`.
* **Поля ответа:**
  * услуги (`categories[].services[]`): `id`, `name`, `description`, `durationMin`, `kind` (`addon` — «Дополнение»), `isFeatured` (какие показать), `priceMasterKop`, `priceTopKop` (цена «от»), `priceUnit`;
  * мастера: `id`, `name`, `specialty`, `bio`, `photoUrl` (нет фото — инициалы);
  * галерея (`photos[]`): `url`, `title`, `service.name`, `master.id`, `master.name`;
  * студия: `address`, `phone`, `mapUrl`, `vkUrl`, `telegramUrl`, `hours[]` (`weekday`, `open`, `close`), `rules.clientChangeDeadlineHours`.

## Вход и регистрация

**AUTH-01 Вход** — `#/login`
* **Файл:** `web/login.html`, `js/login.js`.
* **Показывает:** телефон или e-mail, пароль, ошибку входа; плашку «Войдите, чтобы закрепить время и завершить запись», если пришли с шага «Время».
* **Эндпоинты:** `POST /api/auth/login`.
* **Поля ответа:** `user.role` (клиент — в кабинет или на `?next=`, сотрудник — на главную); коды `INVALID_CREDENTIALS`, `LOGIN_LOCKED` с заголовком `Retry-After`.

**AUTH-03 Регистрация и AUTH-02 Код из письма** — `#/register`, `#/verify`
* **Файл:** `web/register.html`, `js/register.js`. Код из письма — шаг этой же страницы.
* **Показывает:** имя, телефон, e-mail, пароль, согласия; «Такой аккаунт уже есть» с «Войти»; шаг кода: «Код отправлен на …, действует … минут», оставшиеся попытки, повторная отправка через 60 секунд; при `delivery: studio` — «Позвоните в студию» с телефоном.
* **Эндпоинты:** `POST /api/auth/register` (без кода и с `code`), `GET /api/studio`.
* **Поля ответа:** `status` (201 или 202), `delivery`, `sentTo`, `expiresInMin`; `details.attemptsLeft` у `INVALID_CODE`; коды `PHONE_TAKEN`, `EMAIL_TAKEN`; студия: `phone`.

**AUTH-06 Восстановление пароля** — `#/forgot-password`
* **Файл:** `web/forgot-password.html`, `js/forgot-password.js`.
* **Показывает:** поле «телефон или e-mail», затем «Проверьте почту» с телефоном студии для тех, у кого e-mail не указан.
* **Эндпоинты:** `POST /api/auth/password-reset/request`, `GET /api/studio`.
* **Поля ответа:** студия: `phone`; у 429 — `Retry-After`. Тело ответа на запрос ссылки экран не читает: оно всегда одинаковое.

**AUTH-08 Новый пароль** — `#/reset-password`
* **Файл:** `web/reset-password.html`, `js/reset-password.js`. Открывается и по пути `/reset-password?token=…` из письма.
* **Показывает:** новый пароль и повтор; «Пароль изменен» или «Ссылка больше не действует».
* **Эндпоинты:** `POST /api/auth/password-reset/confirm`.
* **Поля ответа:** только код `INVALID_CODE` → «Ссылка больше не действует».

## Запись

**BOOK-01 Шаг 1. Услуги** (с окнами BOOK-M4, BOOK-M5, BOOK-M6) — `#/booking/services`
* **Файл:** `web/booking-services.html`, `js/booking-services.js`, `css/booking.css`.
* **Показывает:** поиск, категории, карточки услуг, корзину с количеством у «Дизайна ногтей», итог «N услуг · длительность · цена» и «Далее»; причину, почему услугу нельзя добавить; «Услуги мастера …» при закрепленном мастере.
* **Эндпоинты:** `GET /api/services`, `GET /api/masters`; после каждого изменения корзины — `GET /api/masters?services=…`.
* **Поля ответа:**
  * каталог: `categories[]` (`id`, `name`, `services`), у услуги `id`, `name`, `description`, `durationMin`, `kind`, `maxQuantity`, `priceMasterKop`, `priceTopKop`, `priceUnit`; `incompatibilities[]` (`serviceIds`, `reason`);
  * все мастера: `id`, `name`, `serviceIds`;
  * подходящие мастера: `masters[].visit.priceKop` и `visit.durationMin` — итог корзины считает сервер.

**BOOK-02 Шаг 2. Мастер** — `#/booking/master`
* **Файл:** `web/booking-master.html`, `js/booking-master.js`.
* **Показывает:** сводку корзины, «Любой свободный мастер», подходящих мастеров с уровнем, специализацией, ценой и длительностью визита и строкой «Ближайшее: …»; блок «Не подходят для этого визита» с «Не выполняет: …».
* **Эндпоинты:** `GET /api/masters?services=…`, `GET /api/masters`, `GET /api/services`, `GET /api/studio`; для «Ближайшее» — `GET /api/masters/:id/slots?date=…&services=…` по дням, не дальше 14 дней.
* **Поля ответа:** мастера: `id`, `name`, `level`, `specialty`, `serviceIds`, `visit.priceKop`, `visit.durationMin`; услуги: `id`, `name`; слоты: `slots[].startsAt`; студия: `timezone`, `rules.bookingHorizonDays`.

**BOOK-03 Шаг 3. Время и CAB-04 Перенос записи** — `#/booking/time`, `#/account/bookings/:id/reschedule`
* **Файл:** `web/booking-time.html`, `js/booking-time.js`, `css/booking-time.css`. Перенос — режим этого экрана: `booking-time.html?reschedule=ID`.
* **Показывает:** сводку визита, календарь месяца с точками у дней со свободным временем, закрытые дни с причиной, сетку дня «Утро / День / Вечер» (свободное и занятое), время окончания визита, «Свободны: …» у «Любого мастера», состояние «Мест нет» с ближайшими датами, пометку «У вас запись в это время», окно «Это время только что заняли» с вариантами. В режиме переноса — «Сейчас вы записаны», «Было → Стало» с таймером брони и новой ценой, «Запись перенесена», «Перенос недоступен».
* **Эндпоинты:**
  * слоты: `GET /api/masters/:id/slots?date=…&services=…`, «Любой мастер» — `GET /api/slots?date=…&services=…`, перенос — `GET /api/masters/:id/slots?date=…&bookingId=…`;
  * `GET /api/studio`, `GET /api/studio/days`, `GET /api/services`, `GET /api/masters`, `GET /api/auth/me`, `GET /api/bookings?period=upcoming`;
  * «Продолжить» — `POST /api/holds`;
  * перенос: `GET /api/bookings/:id`, `POST /api/holds` с `bookingId`, `POST /api/bookings/:id/reschedule`.
* **Поля ответа:**
  * слоты: `day.status`, `durationMin`, `priceKop`, `slots[]` (`startsAt`, `endsAt`, `masterIds`), у «Любого мастера» — `masters[]` (`id`, `name`, `priceKop`);
  * студия: `timezone`, `phone`, `hours[]` (`weekday`, `open`), `rules.slotStepMin`, `rules.bookingHorizonDays`; особые дни: `date`, `isOpen`, `open`, `reason`;
  * свои записи: `id`, `status`, `startsAt`, `endsAt`;
  * бронь: `startsAt`, `endsAt`, `secondsLeft`, `priceKop`, `master.name`; у `SLOT_TAKEN` — `details.alternatives[]` (`masterId`, `startsAt`, `endsAt`);
  * переносимая запись: `startsAt`, `endsAt`, `durationMin`, `items`, `master.id`, `master.name`, `totalPriceKop`, `version`.

**BOOK-04 Шаг 4. Подтверждение** (с окнами BOOK-M1, BOOK-M2, BOOK-M3) — `#/booking/confirm`
* **Файл:** `web/booking-confirm.html`, `js/booking-confirm.js`, `css/booking-confirm.css`.
* **Показывает:** таймер брони (за минуту до конца — «Бронь скоро истечет»), «Ваши данные» с «Изменить в профиле», комментарий мастеру, правило 24 часов; сводку: мастер, дата и время, услуги с ценами, адрес, длительность, итог; «У вас уже есть запись на это время»; «Время уже заняли» с вариантами; окна «Время брони истекло» и «Сессия истекла».
* **Эндпоинты:** `GET /api/holds/current`, `POST /api/holds` (если брони нет или она на другое время), `GET /api/auth/me`, `GET /api/studio`, `GET /api/services`, `GET /api/masters`, `GET /api/masters?services=…`, `GET /api/bookings?period=upcoming`, «Подтвердить запись» — `POST /api/bookings`, вход в окне — `POST /api/auth/login`.
* **Поля ответа:**
  * бронь: `masterId`, `startsAt`, `endsAt`, `bookingId`, `secondsLeft`;
  * клиент: `name`, `phone`, `email`;
  * студия: `address`, `phone`, `timezone`, `rules.clientChangeDeadlineHours`;
  * мастер: `id`, `name`, `level` (цена строки — `priceMasterKop` или `priceTopKop` услуги), `visit.priceKop`, `visit.durationMin`;
  * созданная запись: `id`, `master.id`; у `SLOT_TAKEN` — `details.alternatives[]`.

**BOOK-05 Вы записаны** — `#/booking/success`
* **Файл:** `web/booking-success.html`, `js/booking-success.js`, `js/calendar.js`.
* **Показывает:** «Вы записаны!», дату и время, услуги, мастера, адрес, стоимость и длительность; «Добавить в календарь» (файл `.ics` собирает браузер), «Как добраться», «Мои записи», «Записаться еще».
* **Эндпоинты:** `GET /api/bookings/:id`, `GET /api/studio`.
* **Поля ответа:** запись: `startsAt`, `endsAt`, `durationMin`, `totalPriceKop`, `master.name`, `items[]` (`name`, `quantity`); студия: `address`, `mapUrl`, `timezone`, `rules.clientChangeDeadlineHours`.

## Личный кабинет

**CAB-01 Мои записи** (кнопка «Отменить» открывает CAB-05 на карточке) — `#/account`
* **Файл:** `web/account.html`, `js/account.js`, `css/account.css`.
* **Показывает:** «Здравствуйте, {имя}», сообщения «Студия отменила / перенесла запись» с ✕, ближайшую запись в рамке («Предстоит» или «Скоро», «Перенести», «Отменить», «Подробнее» либо подсказку с телефоном студии), остальные предстоящие; пустые состояния «Предстоящих визитов нет» с «Повторить последний визит» и «У вас пока нет записей» с популярными услугами.
* **Эндпоинты:** `GET /api/auth/me`, `GET /api/bookings`, `GET /api/studio`, `GET /api/services` (только когда записей нет совсем), ✕ — `POST /api/bookings/:id/acknowledge`.
* **Поля ответа:** клиент: `name`, `role`; записи: `id`, `status`, `startsAt`, `canChange`, `studioChange`, `master.id`, `master.name`, `items[]` (`serviceId`, `name`, `quantity`); студия: `address`, `phone`, `timezone`, `rules.clientChangeDeadlineHours`; услуги: `id`, `name`, `kind`, `isFeatured`, `priceMasterKop`, `priceTopKop`.

**CAB-02 История** — `#/account/history`
* **Файл:** `web/history.html`, `js/history.js`.
* **Показывает:** прошедшие и отмененные визиты с фильтрами «Все / Завершенные / Отмененные»: дата, услуги, мастер, статус, «Повторить» у завершенных; пустое состояние «Здесь появятся ваши прошедшие визиты».
* **Эндпоинты:** `GET /api/bookings?period=past` (фильтр по статусу — в браузере), `GET /api/studio`.
* **Поля ответа:** записи: `id`, `status`, `startsAt`, `master.id`, `master.name`, `items[]` (`serviceId`, `name`, `quantity`); студия: `timezone`.

**CAB-03 Карточка записи и CAB-05 Отмена записи** — `#/account/bookings/:id`
* **Файл:** `web/booking.html`, `js/booking-card.js`, `css/booking-card.css`. Отмена — окно на этой странице, `?cancel=1` открывает его сразу.
* **Показывает:** услуги с ценами, статус, дату и время, мастера, стоимость, комментарий, причину отмены студией, сообщение студии с ✕, адрес с «Как добраться» и «В календарь»; кнопки по статусу и сроку: «Перенести» и «Отменить», «Изменить запись можно только через студию» с телефоном, «Повторить запись», «Выбрать новое время». Окно отмены: сводка, причины и «Другое», «Может, перенести?», «До визита осталось мало времени…», «Запись отменена».
* **Эндпоинты:** `GET /api/bookings/:id`, `GET /api/studio`, `POST /api/bookings/:id/cancel`, `POST /api/bookings/:id/acknowledge`.
* **Поля ответа:** запись: `id`, `status`, `startsAt`, `endsAt`, `canChange`, `changeDeadline`, `comment`, `totalPriceKop`, `version`, `master.id`, `master.name`, `items[]` (`serviceId`, `name`, `quantity`, `priceKop`), `cancellation.by`, `cancellation.reason`, `studioChange.type`; студия: `address`, `mapUrl`, `phone`, `timezone`, `rules.clientChangeDeadlineHours`.

## Профиль

**CAB-07 Профиль, CAB-10 Удаление аккаунта и AUTH-02 Код для e-mail** — `#/account/profile`
* **Файл:** `web/profile.html`, `js/profile.js`, `css/profile.css`. Вкладки «Личные данные», «Безопасность» (`#security`), «Уведомления» (`#notifications`); код из письма и удаление аккаунта — окна на этой странице.
* **Показывает:** имя с «Сохранить»; телефон только для чтения с телефоном студии; e-mail с «Изменить» или «Добавить» и отметкой «не подтвержден» с «Подтвердить»; окно кода с попытками и повторной отправкой; смену пароля; «Выйти»; «Удалить аккаунт» с паролем; флажок «Получать новости и акции» и описание, где клиент видит уведомления.
* **Эндпоинты:** `GET /api/auth/me`, `GET /api/studio`, `PATCH /api/profile` (имя, согласие на новости), `POST /api/profile/email`, `POST /api/profile/email/confirm`, `POST /api/profile/password`, `DELETE /api/profile`, `POST /api/auth/logout`.
* **Поля ответа:** клиент: `name`, `phone`, `email`, `emailVerified`, `marketingConsent`, `role`; студия: `phone`; код: `sentTo`, `expiresInMin`, `details.attemptsLeft`; коды `WRONG_PASSWORD`, `EMAIL_TAKEN`, `CODE_RECENTLY_SENT` и другие — текстом из ответа.

## Еще не сверстаны

На них уже ведут ссылки, адреса — в `web/js/routes.js`: PUB-05 Профиль мастера (`master.html`), политика обработки персональных данных (`privacy.html`), вход для сотрудников (`staff-login.html`). Служебных экранов SYS-01 «Страница не найдена» и SYS-05 «Технические работы» тоже нет.

Админ-панель и расписание мастера появятся в следующей итерации. Пока они есть только в черновом интерфейсе `web-draft/`: из него 29.09.2026 убраны каталог, регистрация и «Мои записи» — их заменили экраны выше.

## Что пришлось чинить по ходу верстки

Только то, что записано в отчетах сессий верстки и видно в коде. На экранах AUTH-01, AUTH-03, AUTH-06, AUTH-08, BOOK-02, BOOK-04, BOOK-05, CAB-02 и CAB-07 своих поломок не было. Их касаются только поломки общей шапки.

| Экран | Что было не так | Как исправили |
|---|---|---|
| Общая шапка, все страницы с ней | На телефоне у гостя «Войти» и «Регистрация» не помещались рядом с логотипом, и страница становилась на 21 px шире экрана. Это касалось и экранов входа | Сначала «Регистрацию» скрыли на телефоне (`6651506`). При адаптивной верстке выяснилось, что так она на телефоне просто пропадает, а у клиента пропадала «Записаться». Теперь у гостя «Регистрация» — в меню по кнопке с тремя полосками, у клиента «Записаться» и имя — в меню аккаунта (`c26f72e`, `js/header.js`, `css/header.css`) |
| PUB-01 Лендинг | На телефоне кнопка «Регистрация» в меню разделов была со светлым текстом на розовом фоне, а по дизайн-системе текст темный | Текст кнопки задан цветом `--color-button-text` (`c26f72e`, `css/landing.css`) |
| PUB-01 Лендинг, фото на первом экране | На компьютере кадр резался с обеих сторон, и костяшки руки упирались в правый край. На телефоне за текстом стояли огромные размытые пальцы. На телефоне и планшете был виден верхний край фото ровной линией. На планшете слева от руки был вертикальный шов, а на ширине 524–767 px рука то уменьшалась, то обрезалась | Кадр прижат вправо. На телефоне рука уменьшена и стоит в правом нижнем углу. Левый и верхний края фото растворяются в темноте. Для 768–1023 px и 524–767 px сделаны отдельные раскладки, на 524–767 px размер руки считается от ширины экрана (`ab65e77`, `css/landing.css`) |
| BOOK-01…BOOK-03, нижняя панель с итогом и «Далее» | На телефоне раскрытый список услуг перекрывал последние карточки | Панель прилипает к низу, но остается в потоке страницы, а длинный список прокручивается внутри нее. Из-за кнопок 44 px строка «Дизайн ногтей» не помещалась в ширину, поэтому количество, цена и «×» переходят под название (`c26f72e`, `css/booking.css`) |
| BOOK-03 Время | На телефоне после нажатия на день сетка времени оставалась ниже края экрана, и казалось, что нажатие ничего не сделало | После выбора дня страница сама прокручивается к времени этого дня (`6651506`, `js/booking-time.js`) |
| CAB-01 Мои записи | Если ломался скрипт самой страницы, клиент видел технический текст вроде «Cannot read properties…» | Клиент видит «Что-то пошло не так на странице. Обновите ее или попробуйте позже», подробности уходят в консоль (`bc1f69a`, `js/account.js`) |
| CAB-03 Карточка записи | Кнопки карточки появлялись в шапке сайта: у блока кнопок карточки был тот же атрибут `data-actions`, что у шапки, и скрипт карточки находил первый блок на странице — шапочный | Атрибут в карточке переименован в `data-detail-actions` (`6651506`, `booking.html`, `js/booking-card.js`) |
| CAB-03 Карточка записи | На телефоне карточка была на 36 px шире экрана: длинное название «ЛАМИНИРОВАНИЕ БРОВЕЙ» и статус стояли в одну строку | Статус переносится на следующую строку (`6651506`, `css/booking-card.css`) |
