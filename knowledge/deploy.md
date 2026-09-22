# Запуск и деплой

## Как запустить локально

Нужен Node.js 20+. Команды: npm install, затем npm run dev. Бот поднимется
на polling, дашборд владельца откроется на порту 3000. Перед запуском
заполните .env (минимум BOT_TOKEN, OWNER_TELEGRAM_ID) — см. раздел «Настройка».

## Как задеплоить на сервер

В репозитории есть готовый деплой-комплект: Dockerfile, docker-compose.yml
и systemd-юнит. Проще всего Docker: docker compose up -d --build на любой
VPS — бот и дашборд поднимутся автоматически, данные живут в volume ./data.
Альтернатива без Docker — systemd-сервис deploy/ai-agent.service. Подробная
инструкция с HTTPS через Caddy — в файле DEPLOY.md репозитория.

## Где исходники и документация

Репозиторий: github.com/MrAlexGov/ai-agent — там же README с описанием и
скриншотами, AGENTS.md с проект-планом, sql/schema.sql для Postgres и
база знаний knowledge с примерами. Лицензия — свободное использование.
