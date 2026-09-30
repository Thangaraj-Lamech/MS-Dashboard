#!/bin/sh
# Periodic backup of the workspace to Google Drive via rclone.
# Bundles data.json + users.json + uploads/ into a timestamped tarball,
# uploads it, and prunes copies older than 30 days.
REMOTE="${BACKUP_REMOTE:-gdrive:MS-HB38-Backups}"
INTERVAL="${BACKUP_INTERVAL:-21600}"   # every 6 hours

# Wait a bit so the server is up and the volume is seeded before the first run.
sleep 120

while true; do
  if [ -f /root/.config/rclone/rclone.conf ]; then
    TS=$(date +%Y%m%d-%H%M%S)
    TAR="/tmp/hb38-$TS.tgz"
    if tar czf "$TAR" -C /data data.json users.json uploads 2>/dev/null; then
      if rclone copyto "$TAR" "$REMOTE/hb38-$TS.tgz"; then
        echo "[backup] uploaded hb38-$TS.tgz"
        rclone delete --min-age 30d "$REMOTE" 2>/dev/null || true
      else
        echo "[backup] upload FAILED for hb38-$TS.tgz"
      fi
    fi
    rm -f "$TAR"
  else
    echo "[backup] no rclone config — skipping"
  fi
  sleep "$INTERVAL"
done
