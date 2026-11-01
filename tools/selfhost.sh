#!/usr/bin/env bash
# =============================================================================
#  STORAGE&MESS — свой сервер одной командой (самохост).
#
#    tools/selfhost.sh            собрать (первый раз) и запустить
#    tools/selfhost.sh --build    только собрать и настроить
#
#  Работает и без интернета: телефоны и десктопы в той же сети находят сервер
#  сами (Настройки → «Свой сервер» → «Найти сервер рядом»).
#
#  Первый запуск: ставит зависимости, собирает веб и сервер, создаёт .env со
#  СЛУЧАЙНЫМИ секретами и самоподписанный сертификат на адреса этой машины
#  (без HTTPS браузеры не дают микрофон и камеру). Нужны Node.js 20+ и openssl.
#
#  Порт — SMESS_PORT (по умолчанию 8443). Имя сервера — SMESS_NAME.
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMESS_PORT:-8443}"
NAME="${SMESS_NAME:-$(hostname)}"

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✔ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n\n' "$*"; exit 1; }

command -v node >/dev/null || die "Нужен Node.js 20+ (https://nodejs.org)"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Нужен Node.js 20+, сейчас $(node -v)"
command -v openssl >/dev/null || die "Нужен openssl"

LAN_IPS="$(node -e 'for (const l of Object.values(require("os").networkInterfaces())) for (const a of l||[]) if (a.family==="IPv4"&&!a.internal) console.log(a.address)')"
FIRST_IP="$(echo "$LAN_IPS" | head -1)"

say "Сборка"
if [ ! -d "$ROOT/web-client/node_modules" ]; then (cd "$ROOT/web-client" && npm ci --no-audit --no-fund); fi
if [ ! -f "$ROOT/web-client/dist/index.html" ] || [ "${1:-}" = "--build" ]; then (cd "$ROOT/web-client" && npx vite build >/dev/null); fi
ok "веб собран"
if [ ! -d "$ROOT/server/node_modules" ]; then (cd "$ROOT/server" && npm ci --no-audit --no-fund); fi
(cd "$ROOT/server" && npx tsc --noEmitOnError) || die "Сервер не собрался"
ok "сервер собран"

say "Настройка"
ENV="$ROOT/server/.env"
if [ ! -f "$ENV" ]; then
  rnd() { node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'; }
  umask 077
  cat > "$ENV" <<EOF
# Создано tools/selfhost.sh $(date '+%F %T'). Секреты случайные — не публикуйте этот файл.
PORT=$PORT
HOST=0.0.0.0
NODE_ENV=production
SERVER_NAME=$NAME
SERVER_URL=https://${FIRST_IP:-localhost}:$PORT
DOMAIN=${FIRST_IP:-localhost}
JWT_SECRET=$(rnd)
JWT_EXPIRES_IN=7d
ADMIN_SECRET=$(rnd)
USER_ENCRYPTION_KEY=$(rnd)
DATABASE_URL=./data/kotex.db
STORAGE_PATH=./storage
MAX_FILE_SIZE=10737418240
LOCAL_STUN_PORT=${SMESS_STUN_PORT:-3478}
LOCAL_RELAY_PORT_MIN=50000
LOCAL_RELAY_PORT_MAX=50100
EXTERNAL_PORT=$PORT
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=10000
EOF
  ok ".env создан со случайными секретами (права 600)"
else
  ok ".env уже есть — не трогаю"
fi
mkdir -p "$ROOT/server/data" "$ROOT/server/storage" "$ROOT/server/certs"
if [ ! -f "$ROOT/server/certs/cert.pem" ]; then
  SAN="DNS:localhost,IP:127.0.0.1"
  for ip in $LAN_IPS; do SAN="$SAN,IP:$ip"; done
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$NAME" -addext "subjectAltName=$SAN" \
    -keyout "$ROOT/server/certs/key.pem" -out "$ROOT/server/certs/cert.pem" 2>/dev/null
  chmod 600 "$ROOT/server/certs/key.pem"
  ok "самоподписанный сертификат на: $(echo $LAN_IPS | tr ' ' ',')"
fi

[ "${1:-}" = "--build" ] && { say "Готово (только сборка)"; exit 0; }

say "Запуск: $NAME"
for ip in $LAN_IPS; do echo "  https://$ip:$PORT"; done
echo "  Телефоны в этой сети: Настройки → «Свой сервер» → «Найти сервер рядом»."
echo "  Сертификат самоподписанный — браузер попросит подтвердить один раз."
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "  Фаервол ufw включён — откройте порты, иначе телефоны не найдут и не достучатся:"
  echo "    sudo ufw allow $PORT/tcp && sudo ufw allow 47620/udp"
fi
cd "$ROOT/server" && exec node dist/index.js
