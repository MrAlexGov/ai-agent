# ---------- Сборка: компилируем TypeScript ----------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc

# ---------- Прод: только dist + prod-зависимости ----------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist
COPY knowledge ./knowledge
COPY sql ./sql
COPY AGENTS.md README.md ./

# Данные JSON-режима (если не задан DATABASE_URL)
VOLUME ["/app/data"]

# tsc с текущим tsconfig кладёт код в dist/src (в include входят src и scripts)
CMD ["node", "dist/src/index.js"]
