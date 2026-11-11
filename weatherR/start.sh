#!/bin/zsh
# Одна команда: туннель Cloudflare + бот weatherR для Telegram.
# Остановка: Ctrl+C в этом окне.
# cloudflared нужен именно для Mini App: бесплатный ngrok показывает свою
# заставку и в Telegram открывается пустой экран с роботом.

set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "Нет файла .env. Скопируйте .env.example и впишите BOT_TOKEN."
  exit 1
fi

if ! command -v cloudflared >/dev/null; then
  echo "Нужен cloudflared. Установка: brew install cloudflared"
  exit 1
fi

if ! command -v python3 >/dev/null; then
  echo "Нужен python3."
  exit 1
fi

PORT="$(python3 -c '
from pathlib import Path
port = "8080"
for line in Path(".env").read_text().splitlines():
    if line.startswith("PORT="):
        port = line.split("=", 1)[1].strip() or "8080"
print(port)
')"

# Если порт занят старым weatherR — гасим его сами.
# Раньше скрипт сразу выходил с «Порт занят», и казалось, что ./start.sh «не запускает» бота.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Порт $PORT занят — останавливаю предыдущий запуск…"
  ./stop.sh || true
  sleep 0.8
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Порт $PORT всё ещё занят чужим процессом:"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN
  echo "Освободите порт и повторите ./start.sh"
  exit 1
fi

# один экземпляр туннеля: иначе опрос Telegram даёт HTTP 409
pkill -f "ngrok http" 2>/dev/null || true
pkill -f "cloudflared tunnel --url http://127.0.0.1:${PORT}" 2>/dev/null || true
sleep 0.3

LOG="$(mktemp -t weatherr-tunnel)"
cloudflared tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate >"$LOG" 2>&1 &
TUNNEL_PID=$!

cleanup() {
  echo
  echo "Остановка…"
  kill "$TUNNEL_PID" 2>/dev/null || true
  wait "$TUNNEL_PID" 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT INT TERM

echo "Жду адрес туннеля…"
URL=""
for _ in {1..50}; do
  URL="$(python3 -c '
import re, pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text(errors="ignore")
m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", text)
print(m.group(0) if m else "")
' "$LOG")"
  if [[ -n "$URL" ]]; then
    break
  fi
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "Туннель не поднялся:"
    cat "$LOG"
    exit 1
  fi
  sleep 0.5
done

if [[ -z "$URL" ]]; then
  echo "Не дождался адреса trycloudflare.com"
  cat "$LOG"
  exit 1
fi

python3 -c '
from pathlib import Path
import sys
url = sys.argv[1]
path = Path(".env")
lines = []
for line in path.read_text().splitlines():
    if line.startswith("WEBAPP_URL="):
        lines.append("WEBAPP_URL=" + url)
    else:
        lines.append(line)
path.write_text("\n".join(lines) + "\n")
' "$URL"

echo "Туннель: $URL"
echo "Локально: http://127.0.0.1:${PORT}"
echo "В чат сообщения не шлём. Откройте синюю кнопку weatherR слева от поля ввода."
echo

exec python3 bot.py
