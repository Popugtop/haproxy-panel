#!/usr/bin/env bash
# Подготовка локального запуска: Postgres в Docker, .env, администратор.
set -euo pipefail
cd "$(dirname "$0")/.."

docker info >/dev/null 2>&1 || { echo "Docker не запущен. Откройте Docker Desktop и повторите." >&2; exit 1; }

if [ ! -f .env ]; then
  cat > .env <<ENV
NODE_ENV=development
DATABASE_URL=postgres://popug:popug-dev@127.0.0.1:5433/popug
APP_SECRET=$(openssl rand -hex 32)
PUBLIC_URL=http://localhost:3000
AGENT_DIST=./agent/dist
ENV
  echo "создан .env"
fi

docker compose -f deploy/docker-compose.dev.yml up -d --wait postgres

[ -d node_modules ] || npm install

# install.sh и бинарники агента панель отдаёт из AGENT_DIST
mkdir -p agent/dist
cp agent/install.sh agent/packaging/popug-agent.service agent/dist/
if [ ! -f agent/dist/popug-agent-linux-amd64 ]; then (cd agent && make dist >/dev/null 2>&1 || echo "агент не собран (нужен Go): команда установки на мост пока не заработает"); fi

if [ -z "$(cd panel/server && npm run -s cli -- list-users 2>/dev/null)" ]; then
  PASS="$(openssl rand -base64 18 | tr -d '/+=')"
  (cd panel/server && npm run -s cli -- create-admin admin --password "$PASS" >/dev/null)
  echo
  echo "Администратор создан:  логин admin   пароль $PASS"
  echo "(пароль показывается один раз; TOTP настроите при первом входе)"
fi

cat <<MSG

Готово. Запустите в двух терминалах:
  npm run dev:server     # панель, :3000
  npm run dev:web        # интерфейс, откройте http://localhost:5173
MSG
