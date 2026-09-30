#!/usr/bin/env bash
# Show whether the MS (HB38) Workspace is running and the current public link.
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:8000/)
[ "$code" = "200" ] && echo "Server:  running (http://localhost:8000/)" || echo "Server:  NOT running  -> run ./start.sh"

if ps -eo args | awk '$1 ~ /cloudflared$/ && $2=="tunnel"' | grep -q .; then
  url=$(cat public_url.txt 2>/dev/null)
  echo "Tunnel:  running"
  echo "Public link: ${url:-(not known yet)}"
  [ -n "$url" ] && echo "Public check: HTTP $(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url/")"
else
  echo "Tunnel:  NOT running  -> run ./start.sh"
fi
