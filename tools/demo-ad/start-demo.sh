#!/usr/bin/env bash
# =============================================================================
#  Демо корпоративного контура STORAGE&MESS — всё на этой машине, только 127.0.0.1:
#    мессенджер          http://127.0.0.1:9400
#    консоль учебного AD http://127.0.0.1:9480   (отключить, заблокировать, уволить)
#    учебный AD (LDAP)   ldap://127.0.0.1:1389
#    учебный RADIUS      udp 127.0.0.1:1812
#
#  Пароли для показа — tools/demo-ad/state/passwords.txt. Остановить — stop-demo.sh.
#  DEMO_AUTH=ldap | radius | ldap+radius — чем проверять пароль при входе (по умолчанию ldap).
# =============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ST="$HERE/state"
say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✔ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n\n' "$*"; exit 1; }
mkdir -p "$ST"; chmod 700 "$ST"

running() { [ -f "$ST/$1.pid" ] && kill -0 "$(cat "$ST/$1.pid")" 2>/dev/null; }
for s in directory radius server; do running "$s" && die "Демо уже запущено ($s). Сначала tools/demo-ad/stop-demo.sh"; done
for p in 9400 9480 1389; do ss -ltnH "sport = :$p" | grep -q . && die "Порт $p занят — демо не запускаю"; done

say "Зависимости и сборка"
[ -d "$HERE/node_modules" ] || (cd "$HERE" && npm ci --no-audit --no-fund)
[ -d "$ROOT/server/node_modules" ] || (cd "$ROOT/server" && npm ci --no-audit --no-fund)
[ -d "$ROOT/web-client/node_modules" ] || (cd "$ROOT/web-client" && npm ci --no-audit --no-fund)
(cd "$ROOT/server" && npx tsc --noEmitOnError) || die "Сервер не собрался"
ok "сервер собран"
if [ ! -f "$ROOT/web-client/dist/index.html" ] || [ "${DEMO_REBUILD:-}" = 1 ]; then
  (cd "$ROOT/web-client" && VITE_SAME_ORIGIN=1 npx vite build >/dev/null) || die "Клиент не собрался"
fi
ok "клиент собран"

say "Учебный каталог и RADIUS"
node "$HERE/directory-server.cjs" --init
node "$HERE/radius-server.cjs" --init
SVC_PW="$(awk '/^svc-messenger/{print $2}' "$ST/passwords.txt")"
RAD_SECRET="$(cat "$ST/radius-secret")"

ENV="$ROOT/server/.env"
if [ ! -f "$ENV" ]; then
  umask 077
  rnd() { node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'; }
  cat > "$ENV" <<EOF
# Демо корпоративного контура — создано start-demo.sh $(date '+%F %T'). Секреты случайные.
PORT=9400
HOST=127.0.0.1
NODE_ENV=production
SERVER_NAME=STORAGE&MESS Enterprise (демо)
SERVER_URL=http://127.0.0.1:9400
DOMAIN=127.0.0.1
JWT_SECRET=$(rnd)
JWT_EXPIRES_IN=15m
ADMIN_SECRET=$(rnd)
USER_ENCRYPTION_KEY=$(rnd)
DATABASE_URL=./data/enterprise-demo.db
STORAGE_PATH=./storage
LAN_DISCOVERY=0
LOCAL_STUN_PORT=9478
LOCAL_RELAY_PORT_MIN=50200
LOCAL_RELAY_PORT_MAX=50220
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=10000

ENT_DIRECTORY=ldap
ENT_LDAP_URL=ldap://127.0.0.1:1389
ENT_LDAP_BIND_DN=CN=svc-messenger,OU=Service Accounts,DC=corp,DC=example
ENT_LDAP_BIND_PASSWORD=$SVC_PW
ENT_LDAP_BASE_DN=DC=corp,DC=example
ENT_LDAP_GROUP_DN=CN=Messenger Users,OU=Groups,DC=corp,DC=example
ENT_LDAP_ADMIN_GROUP_DN=CN=Messenger Admins,OU=Groups,DC=corp,DC=example
ENT_DOMAIN=CORP
ENT_SYNC_INTERVAL_S=10
ENT_AUTH=${DEMO_AUTH:-ldap}
ENT_RADIUS_HOST=127.0.0.1
ENT_RADIUS_PORT=1812
ENT_RADIUS_SECRET=$RAD_SECRET
ENT_BREAKGLASS_ADMIN=avaria
ENT_BREAKGLASS_HASH=
EOF
  chmod 600 "$ENV"
  ok ".env демо создан (права 600)"
elif [ -n "${DEMO_AUTH:-}" ]; then
  sed -i "s/^ENT_AUTH=.*/ENT_AUTH=$DEMO_AUTH/" "$ENV"; ok "вход: $DEMO_AUTH"
fi

# Аварийный локальный админ: пароль — state/breakglass-password, в .env только хеш
if [ ! -s "$ST/breakglass-password" ] || ! grep -q '^ENT_BREAKGLASS_HASH=\$2' "$ENV"; then
  ( umask 077; node -e 'console.log("Avaria-" + require("crypto").randomBytes(6).toString("base64url"))' > "$ST/breakglass-password" )
  BG_HASH="$(cd "$ROOT/server" && node -e 'console.log(require("bcryptjs").hashSync(require("fs").readFileSync(process.argv[1], "utf8").trim(), 12))' "$ST/breakglass-password")"
  BG_HASH="$BG_HASH" node -e '
    const fs = require("fs"); const p = process.argv[1];
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/^ENT_BREAKGLASS_HASH=.*$/m, "ENT_BREAKGLASS_HASH=" + process.env.BG_HASH), { mode: 0o600 });
  ' "$ENV"
  ok "пароль аварийного админа выпущен"
fi
node "$HERE/directory-server.cjs" --init --passwords >/dev/null

say "Запуск"
start() {  # $1 — имя, остальное — команда
  local name="$1"; shift
  nohup "$@" >> "$ST/$name.log" 2>&1 &
  echo $! > "$ST/$name.pid"
}
start directory node "$HERE/directory-server.cjs"
start radius node "$HERE/radius-server.cjs"
(cd "$ROOT/server" && start server node dist/index.js)
for i in $(seq 1 60); do
  curl -s --noproxy '*' -A 'Mozilla/5.0 (X11; Linux x86_64) SmessDemo/1.0' -o /dev/null -w '%{http_code}' http://127.0.0.1:9400/api/enterprise/info 2>/dev/null | grep -q 200 && break
  sleep 1
done
curl -s --noproxy '*' -A 'Mozilla/5.0 (X11; Linux x86_64) SmessDemo/1.0' http://127.0.0.1:9400/api/enterprise/info | grep -q '"enabled":true' || die "Сервер демо не поднялся — см. $ST/server.log"
ok "мессенджер:          http://127.0.0.1:9400"
ok "консоль учебного AD: http://127.0.0.1:9480"
ok "пароли для показа:   $ST/passwords.txt"
