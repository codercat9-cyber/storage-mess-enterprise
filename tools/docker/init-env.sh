#!/usr/bin/env bash
# Создать .env для docker compose со случайными секретами.
#   ./tools/docker/init-env.sh           — под настоящий каталог (дальше впишите свои ENT_LDAP_*)
#   ./tools/docker/init-env.sh --demo    — под учебный AD из профиля demo
# Существующий .env не трогает.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ "${1:-}" = "--set-breakglass" ]; then
  [ -n "${2:-}" ] && [ -e .env ] || { echo "нужно: --set-breakglass <пароль>, и .env должен быть"; exit 1; }
  HASH="$(docker compose run --rm --no-deps -T messenger node -e 'console.log(require("bcryptjs").hashSync(process.argv[1], 12))' "$2")"
  case "$HASH" in '$2'*) ;; *) echo "хэш не получился: $HASH"; exit 1 ;; esac
  python3 - "$HASH" <<'PY2'
import re, sys
p = '.env'; s = open(p, encoding='utf-8').read()
s = re.sub(r'^ENT_BREAKGLASS_HASH=.*$', 'ENT_BREAKGLASS_HASH=' + sys.argv[1], s, flags=re.M)
open(p, 'w', encoding='utf-8').write(s)
PY2
  echo "✓ хэш аварийного администратора записан в .env — перезапустите: docker compose up -d"
  exit 0
fi
[ -e .env ] && { echo ".env уже есть — не трогаю"; exit 0; }
rnd() { openssl rand -hex "${1:-32}"; }
DEMO=0; [ "${1:-}" = "--demo" ] && DEMO=1
umask 077
SVC_PW="$(rnd 12)"; RAD="$(rnd 18)"; BG_PW="$(rnd 9)"
cat > .env <<ENV
# STORAGE&MESS Enterprise — создано $(date '+%F %T'). Секреты случайные, файл — только для администратора.
NODE_ENV=production
SERVER_NAME=STORAGE&MESS Enterprise
# Адрес, по которому сотрудники открывают мессенджер (за обратным прокси — его адрес)
SERVER_URL=http://localhost:8080
DOMAIN=localhost
MESSENGER_PORT=8080
JWT_SECRET=$(rnd)
JWT_EXPIRES_IN=15m
ADMIN_SECRET=$(rnd)
DATABASE_URL=./data/messenger.db
STORAGE_PATH=./storage
MAX_FILE_SIZE=104857600
# Звонки: адрес сервера, который видят клиенты, и порты (их же публикует docker-compose.yml)
MEDIASOUP_ANNOUNCED_IP=
LOCAL_STUN_PORT=3478
LOCAL_RELAY_PORT_MIN=50000
LOCAL_RELAY_PORT_MAX=50100
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=10000

# ── Корпоративный контур: учётки из каталога (AD / FreeIPA по LDAP)
ENT_DIRECTORY=ldap
ENT_LDAP_URL=$([ $DEMO = 1 ] && echo ldap://demo-ad:1389 || echo ldaps://dc01.corp.example:636)
ENT_LDAP_BIND_DN=CN=svc-messenger,OU=Service Accounts,DC=corp,DC=example
ENT_LDAP_BIND_PASSWORD=$([ $DEMO = 1 ] && echo "$SVC_PW" || echo "")
ENT_LDAP_BASE_DN=DC=corp,DC=example
ENT_LDAP_GROUP_DN=CN=Messenger Users,OU=Groups,DC=corp,DC=example
ENT_LDAP_ADMIN_GROUP_DN=CN=Messenger Admins,OU=Groups,DC=corp,DC=example
ENT_DOMAIN=CORP
ENT_SYNC_INTERVAL_S=$([ $DEMO = 1 ] && echo 10 || echo 300)
# Вход: ldap — паролем домена; radius — через RADIUS (второй фактор)
ENT_AUTH=ldap
ENT_RADIUS_HOST=$([ $DEMO = 1 ] && echo demo-ad || echo "")
ENT_RADIUS_PORT=1812
ENT_RADIUS_SECRET=$RAD
# Аварийный локальный администратор на случай, когда домен недоступен
ENT_BREAKGLASS_ADMIN=avaria
ENT_BREAKGLASS_HASH=
ENV
echo "✓ .env создан."
echo "  Пароль аварийного администратора «avaria»: $BG_PW — сохраните, больше он нигде не показывается."
echo "  Его хэш впишется после сборки образа:"
echo "    docker compose build messenger && ./tools/docker/init-env.sh --set-breakglass '$BG_PW'"
