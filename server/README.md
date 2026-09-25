# Сервер «Ноготочки»

Node.js + TypeScript, база SQLite (`better-sqlite3`). Схема базы — `docs/db-schema.md`.

## Первый запуск

```bash
cd server
npm install
cp .env.example .env     # заполнить SEED_ADMIN_PASSWORD и SEED_CLIENT_PASSWORD
npm run db:reset         # создать базу data/nogotochki.db с тестовыми данными
```

## Команды

| Команда | Что делает |
|---|---|
| `npm run db:migrate` | Создает файл базы, если его нет, и применяет новые миграции |
| `npm run db:seed` | Заполняет пустую базу тестовыми данными |
| `npm run db:reset` | Удаляет файл базы и создает заново: миграции + тестовые данные |
| `npm run typecheck` | Проверка типов TypeScript |

Тестовые входы: администратор `admin@example.com`, клиентка `maria@example.com` (пароли — из `.env`).

## Миграции

Файлы `src/db/migrations/NNN_description.sql` применяются по порядку номеров, каждый один раз. Примененную миграцию не правят (сервер это заметит по контрольной сумме): изменение схемы — новый файл со следующим номером.
