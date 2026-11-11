#!/bin/zsh
# Останавливает локальный бот weatherR и его Cloudflare-туннель.

set -euo pipefail
cd "$(dirname "$0")"

PORT="$(python3 -c '
from pathlib import Path
port = "8080"
path = Path(".env")
if path.exists():
    for line in path.read_text().splitlines():
        if line.startswith("PORT="):
            port = line.split("=", 1)[1].strip() or "8080"
print(port)
' 2>/dev/null || echo 8080)"

pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if [[ -n "$pids" ]]; then
  echo "Останавливаю бот на порту $PORT: $pids"
  kill $pids 2>/dev/null || true
fi

tunnel_pids="$(pgrep -f 'cloudflared tunnel --url http://127.0.0.1:'"$PORT" || true)"
if [[ -n "$tunnel_pids" ]]; then
  echo "Останавливаю cloudflared: $tunnel_pids"
  kill $tunnel_pids 2>/dev/null || true
fi

ngrok_pids="$(pgrep -f "ngrok http" || true)"
if [[ -n "$ngrok_pids" ]]; then
  echo "Останавливаю ngrok: $ngrok_pids"
  kill $ngrok_pids 2>/dev/null || true
fi

sleep 0.5
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Порт $PORT ещё занят, принудительно…"
  kill -9 $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t) 2>/dev/null || true
fi

echo "Готово."
