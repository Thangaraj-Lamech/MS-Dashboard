#!/usr/bin/env bash
# Start the MS (HB38) Workspace server + public tunnel, fully detached
# from any terminal / VS Code / Claude session.
#   ./start.sh     start (or restart) everything
#   ./stop.sh      stop everything
#   ./status.sh    show whether it's running + the current public link

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
mkdir -p logs

"$DIR/stop.sh" >/dev/null 2>&1

# Watchdog 1: the Node server (restarts it if it ever exits)
setsid nohup bash -c '
  while true; do
    echo "[$(date "+%F %T")] starting server" >> logs/server.log
    node server.js >> logs/server.log 2>&1
    sleep 3
  done' > /dev/null 2>&1 < /dev/null &
echo $! > logs/server-watchdog.pid

# Watchdog 2: the Cloudflare quick tunnel (restarts it if it ever exits,
# and writes the current public link to public_url.txt)
setsid nohup bash -c '
  while true; do
    echo "[$(date "+%F %T")] starting tunnel" >> logs/tunnel.log
    "$HOME/bin/cloudflared" tunnel --no-autoupdate --url http://localhost:8000 2>&1 |
      while IFS= read -r line; do
        echo "$line" >> logs/tunnel.log
        u=$(printf "%s" "$line" | grep -oE "https://[a-z0-9-]+\.trycloudflare\.com")
        [ -n "$u" ] && echo "$u" > public_url.txt
      done
    sleep 5
  done' > /dev/null 2>&1 < /dev/null &
echo $! > logs/tunnel-watchdog.pid

echo "Started. Waiting for the public link..."
rm -f public_url.txt
for i in $(seq 1 30); do [ -s public_url.txt ] && break; sleep 1; done
if [ -s public_url.txt ]; then
  echo "Public link: $(cat public_url.txt)   (may take ~30s to become reachable)"
else
  echo "Tunnel still starting - run ./status.sh in a minute."
fi
