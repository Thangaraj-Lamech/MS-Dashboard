#!/bin/sh
# Container entrypoint: prepare the persistent volume, restore rclone config
# from the Fly secret, start the backup loop, then run the server.
set -e

mkdir -p /data/uploads

# First boot only: seed accounts + workspace so nothing is lost on migration.
[ -f /data/data.json ]  || cp /app/seed/data.json  /data/data.json  2>/dev/null || true
[ -f /data/users.json ] || cp /app/seed/users.json /data/users.json 2>/dev/null || true

# Restore the rclone config (Google Drive token) from the base64 Fly secret.
if [ -n "$RCLONE_CONF_B64" ]; then
  mkdir -p /root/.config/rclone
  echo "$RCLONE_CONF_B64" | base64 -d > /root/.config/rclone/rclone.conf
  echo "[entrypoint] rclone config restored"
else
  echo "[entrypoint] no RCLONE_CONF_B64 set — Google Drive backups disabled"
fi

# Backup loop in the background.
/app/backup.sh &

exec node server.js
