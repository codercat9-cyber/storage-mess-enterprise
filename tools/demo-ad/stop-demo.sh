#!/usr/bin/env bash
# Остановить демо корпоративного контура (только свои процессы — по сохранённым PID).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ST="$HERE/state"
for s in server radius directory; do
  f="$ST/$s.pid"
  [ -f "$f" ] || continue
  p="$(cat "$f")"
  if kill -0 "$p" 2>/dev/null; then kill "$p" && echo "остановлен: $s (PID $p)"; fi
  rm -f "$f"
done
