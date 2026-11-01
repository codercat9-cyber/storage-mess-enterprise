#!/usr/bin/env bash
# Шлюз LoRa ↔ STORAGE&MESS: сборка и запуск. Настройки — ~/.config/smess-lora-gateway.json
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$HERE/../../web-client"
"$WEB/node_modules/.bin/esbuild" "$HERE/gateway.ts" --bundle --platform=node --format=cjs \
  --outfile="$HERE/dist/gateway.cjs" --log-level=warning
exec node "$HERE/dist/gateway.cjs"
