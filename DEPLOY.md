# Деплой на сервер (VPS) — этап 9 из AGENTS.md

Три пути на выбор. Бот работает в режиме polling, публичный домен и SSL для
Telegram НЕ нужны — они нужны только дашборду, если открываете его наружу.

## 0. Подготовка (один раз)

```bash
# на сервере: Ubuntu/Debian, нужен Docker ИЛИ Node.js 18+
curl -fsSL https://get.docker.com | sh        # вариант Docker
# или: curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs git
```

Загрузите проект на сервер (любой способ):

```bash
# у себя локально:
scp -r ai-agent/ root@ВАШ_IP:/opt/ai-agent
# или через git:
git clone ВАШ_РЕПОЗИТОРИЙ /opt/ai-agent
```

Создайте `.env` на сервере (не копируйте его через scp из дома — секреты должны
жить только на сервере):

```bash
cd /opt/ai-agent
cp .env.example .env
nano .env    # BOT_TOKEN, OWNER_TELEGRAM_ID, желательно DASHBOARD_PASSWORD
```

## Вариант A. Docker (рекомендуется)

```bash
cd /opt/ai-agent
docker compose up -d --build
docker compose logs -f        # смотрим логи (Ctrl+C — выйти)
```

Готово: бот работает, дашборд на `http://ВАШ_IP:3000`.

Обновление после правок кода/знаний:

```bash
cd /opt/ai-agent && docker compose up -d --build
```

Остановка/рестарт: `docker compose down` / `docker compose restart`.

## Вариант B. systemd без Docker

```bash
cd /opt/ai-agent
npm install
useradd -r -s /bin/false agent && chown -R agent:agent /opt/ai-agent
cp deploy/ai-agent.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ai-agent
journalctl -u ai-agent -f     # логи
```

Обновление: `git pull && npm install && systemctl restart ai-agent`.

## Вариант C. «У меня уже есть что-то запущенное»

Просто запустите `npm run start` в screen/tmux/pm2 — но для продакшена
рекомендую A или B (автоперезапуск после ребута сервера).

## Дашборд наружу: HTTPS за 5 минут

Дашборд с паролем (`DASHBOARD_PASSWORD` в .env) можно открывать на порт 3000,
но правильнее спрятать за HTTPS. Быстрее всего — Caddy (сам получает сертификат):

```bash
apt install -y caddy
nano /etc/caddy/Caddyfile
```

```
bot.example.com {
    reverse_proxy localhost:3000
}
```

```bash
systemctl reload caddy
```

DNS: A-запись `bot.example.com` → IP сервера. Готово: `https://bot.example.com`.

Не хотите домен — ходите на дашборд через SSH-туннель, наружу ничего не открыто:

```bash
ssh -L 3000:localhost:3000 root@ВАШ_IP
# и откройте http://localhost:3000 у себя
```

Файрвол (если открываете порт напрямую): `ufw allow 3000` — только с этим
правилом, а лучше ограничьте по своему IP.

## Чек-лист после деплоя

- [ ] `docker compose logs -f` (или journalctl) — бот написал `Телеграм-бот запущен: @...`
- [ ] Написали боту `/start` в Telegram — он ответил
- [ ] Уведомление владельцу пришло (если нет — сначала /start боту: Telegram запрещает ботам писать первыми)
- [ ] Дашборд открывается, при заданном `DASHBOARD_PASSWORD` просит пароль
- [ ] `DASHBOARD_PASSWORD` задан, если порт 3000 открыт наружу

## Если что-то не так

| Симптом | Причина/решение |
|---|---|
| `Телеграм-бот запущен` не появляется | Неверный BOT_TOKEN или сервер не пускает api.telegram.org (проверьте `curl https://api.telegram.org`) |
| Контейнер постоянно рестартует | Смотрите `docker compose logs`; чаще всего нет `.env` рядом с docker-compose.yml |
| Дашборд недоступен снаружи | Файрвол/группа безопасности хостера: откройте порт или используйте SSH-туннель |
| В JSON-режиме пропали заявки | Проверьте, что volume `./data` примонтирован (см. docker-compose.yml) |
