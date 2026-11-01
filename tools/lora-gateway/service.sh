#!/usr/bin/env bash
# Шлюз LoRa ↔ STORAGE&MESS: запуск со самоперезапуском и журналом.
#   service.sh start | stop | status
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HOME/.local/state/smess-lora-gateway.log"
PIDF="$HOME/.local/state/smess-lora-gateway.pid"
mkdir -p "$(dirname "$LOG")"
case "${1:-start}" in
  start)
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "шлюз уже работает (PID $(cat "$PIDF"))"; exit 0; fi
    if [ ! -r /dev/ttyUSB0 ] || [ ! -w /dev/ttyUSB0 ]; then
      echo "Нет доступа к /dev/ttyUSB0 — нужен один раз: sudo usermod -aG dialout $USER (и перезайти)"; exit 1; fi
    nohup bash -c "while true; do \"$HERE/run.sh\" >> \"$LOG\" 2>&1; echo \"\$(date '+%F %T') шлюз упал — перезапуск через 15 с\" >> \"$LOG\"; sleep 15; done" >/dev/null 2>&1 &
    echo $! > "$PIDF"; echo "шлюз запущен (PID $!), журнал: $LOG" ;;
  stop)
    if [ -f "$PIDF" ]; then P=$(cat "$PIDF"); pkill -P "$P" 2>/dev/null; kill "$P" 2>/dev/null; rm -f "$PIDF"; echo "шлюз остановлен"; else echo "шлюз не запущен"; fi
    for p in $(ps -eo pid,args | awk '$0 ~ /lora-gateway\/dist\/gateway\.cjs/ && $0 !~ /awk/ {print $1}'); do kill "$p"; done ;;
  status)
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "работает (PID $(cat "$PIDF"))"; tail -5 "$LOG"; else echo "не запущен"; fi ;;
esac
