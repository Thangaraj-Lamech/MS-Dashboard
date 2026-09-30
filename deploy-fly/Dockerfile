# MS (HB38) Workspace — container image for Fly.io
# node + rclone (for Google Drive backups). No npm packages needed.
FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends rclone ca-certificates tar coreutils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# App code (HTML filename has a space, so use the JSON/exec form)
COPY ["MS WORKSPACE.html", "./"]
COPY server.js entrypoint.sh backup.sh ./

# First-boot seed: current accounts + workspace data, copied to the
# persistent volume only if it's empty (never overwrites live data).
COPY data.json users.json /app/seed/

RUN chmod +x entrypoint.sh backup.sh

ENV DATA_DIR=/data \
    PORT=8080

EXPOSE 8080
CMD ["./entrypoint.sh"]
