# Образ сервиса «Ноготочки»: сервер API вместе со страницами интерфейса из web/.
#
# Контейнер собирается заново при каждом обновлении, и все, что лежало внутри, пропадает.
# Поэтому данные живут не в образе, а в отдельной папке, которая подключается при запуске:
# база, резервные копии и фото работ (/data, см. переменные ниже). Папки создаются сами при первом
# обращении, поэтому первый запуск на чистом сервере проходит без подготовки.
#
# Сборка и запуск:
#   docker build -t nogotochki .
#   docker run -d --name nogotochki -p 3000:3000 \
#     -v /var/lib/nogotochki:/data \
#     -e APP_URL=https://topbrohuman.ru \
#     --env-file ./server/.env.production \
#     nogotochki
#
# Миграции применяет сам сервер при запуске, до того как начнет отвечать (src/db/auto-migrate.ts):
# набирать команду внутри контейнера не нужно.

# ---------------------------------------------------------------------------
# Сборка: TypeScript превращается в dist/. Версия Node — та же, на которой проект
# разрабатывается (24.19.0); минимум задан в engines package.json и проверяется при установке.
# ---------------------------------------------------------------------------
FROM node:24.19.0-alpine AS build

WORKDIR /app/server

# Сначала только манифесты: пока зависимости не изменились, Docker возьмет этот слой из кеша.
COPY server/package.json server/package-lock.json server/.npmrc ./
RUN npm ci

COPY server/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Запуск: в образ попадает только собранный код и страницы интерфейса.
# node_modules здесь не нужны вовсе — у сервера нет зависимостей:
# база через node:sqlite, HTTP через node:http, хеширование через node:crypto.
# ---------------------------------------------------------------------------
FROM node:24.19.0-alpine

# Часовой пояс самого контейнера роли не играет: время в базе хранится в UTC,
# а в пояс студии его переводит интерфейс (timezone в настройках студии).
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/db/nogotochki.db \
    BACKUP_DIR=/data/backups \
    UPLOADS_DIR=/data/uploads

WORKDIR /app/server

# package.json нужен и в образе: по нему код находит корень сервера, а node-version.mjs — требуемую версию Node.
COPY --from=build /app/server/package.json ./package.json
COPY --from=build /app/server/scripts/node-version.mjs ./scripts/node-version.mjs
COPY --from=build /app/server/dist ./dist
# Страницы разделов /admin и /master отдает сам API после проверки роли (WEB_DIR, по умолчанию ../web).
COPY web/ /app/web

# Папка данных заводится заранее и отдается пользователю node: контейнер работает не под root.
# При подключении именованного тома Docker перенесет на него эти права; для папки с хоста
# права задаются на хосте: chown -R 1000:1000 /var/lib/nogotochki
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000

# Жив ли сервер: порт берется из той же переменной, что и у самого сервера.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/studio').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node запускается напрямую, без npm: тогда SIGTERM от docker stop доходит до сервера,
# и он закрывает соединения и базу сам (обработчики сигналов в src/server.ts).
CMD ["node", "--import", "./scripts/node-version.mjs", "dist/src/server.js"]
