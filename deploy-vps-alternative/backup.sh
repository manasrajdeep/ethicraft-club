#!/usr/bin/env bash
# Nightly backup of the two things that ARE the site: the database and the
# uploaded posters. Everything else can be redeployed from git.
#
#   sudo cp deploy/backup.sh /usr/local/bin/ethicraft-backup
#   sudo chmod +x /usr/local/bin/ethicraft-backup
#   sudo crontab -e   ->   15 2 * * * /usr/local/bin/ethicraft-backup
set -euo pipefail

APP_DIR=${APP_DIR:-/srv/ethicraft}
DEST=${DEST:-/var/backups/ethicraft}
KEEP_DAYS=${KEEP_DAYS:-30}
STAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$DEST"

# .backup() takes a consistent snapshot even while the app is writing;
# copying the .db file directly can capture a torn WAL.
sqlite3 "$APP_DIR/data/ethicraft.db" ".backup '$DEST/ethicraft-$STAMP.db'"

tar -czf "$DEST/uploads-$STAMP.tar.gz" -C "$APP_DIR" uploads

find "$DEST" -type f -mtime "+$KEEP_DAYS" -delete
echo "backup complete: $DEST/ethicraft-$STAMP.db"
