#!/usr/bin/env bash
# Nightly backup of the database, which IS the site: events, their posters
# (stored in the database), the admin account and sessions. Everything else can
# be redeployed from git.
#
#   sudo cp deploy-vps-alternative/backup.sh /usr/local/bin/ethicraft-backup
#   sudo chmod +x /usr/local/bin/ethicraft-backup
#   sudo crontab -e   ->   15 2 * * * /usr/local/bin/ethicraft-backup
#
# Restore with:
#   pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" ethicraft-<stamp>.dump
#
# pg_dump must be the same major version as the database server, or newer.
set -euo pipefail

APP_DIR=${APP_DIR:-/srv/ethicraft}
DEST=${DEST:-/var/backups/ethicraft}
KEEP_DAYS=${KEEP_DAYS:-30}
STAMP=$(date +%Y%m%d-%H%M%S)

# Take the connection string from the app's own .env unless it is already set.
# Only that one line is read: sourcing the whole file would trip over values
# containing spaces or shell characters.
if [[ -z "${DATABASE_URL:-}" ]]; then
  DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' "$APP_DIR/.env" | tail -n 1 | tr -d '\r')
  DATABASE_URL=${DATABASE_URL#[\"\']}
  DATABASE_URL=${DATABASE_URL%[\"\']}
fi
: "${DATABASE_URL:?is not set, and was not found in $APP_DIR/.env}"

# The dump holds the admin password hash and live sessions: owner-only.
umask 077
mkdir -p "$DEST"

# Write under a temporary name and rename on success, so a failed run never
# leaves something that looks like a good backup.
PARTIAL="$DEST/.ethicraft-$STAMP.partial"
trap 'rm -f "$PARTIAL"' EXIT

# pg_dump takes a consistent snapshot while the app keeps running. The custom
# format is compressed, and pg_restore can pick single tables out of it.
pg_dump --format=custom --no-owner --file="$PARTIAL" "$DATABASE_URL"
mv "$PARTIAL" "$DEST/ethicraft-$STAMP.dump"

find "$DEST" -name 'ethicraft-*.dump' -type f -mtime "+$KEEP_DAYS" -delete
echo "backup complete: $DEST/ethicraft-$STAMP.dump"
