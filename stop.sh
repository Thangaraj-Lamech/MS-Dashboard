#!/usr/bin/env bash
# Stop the MS (HB38) Workspace server + tunnel and their watchdogs.
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

for f in logs/server-watchdog.pid logs/tunnel-watchdog.pid; do
  if [ -f "$f" ]; then
    pid=$(cat "$f")
    # the watchdog runs in its own session; kill that whole group
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null
    rm -f "$f"
  fi
done

# also stop any copies started by hand (exact program match, not the shell)
ps -eo pid,args | awk '$2=="node" && $3=="server.js"{print $1}' | xargs -r kill 2>/dev/null
ps -eo pid,args | awk '$2 ~ /cloudflared$/ && $3=="tunnel"{print $1}' | xargs -r kill 2>/dev/null
echo "Stopped."
