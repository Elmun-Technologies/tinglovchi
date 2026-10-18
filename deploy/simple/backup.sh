#!/usr/bin/env bash
# Copies every recording and analysis into ./backups/suhbat-<date>.tar.gz.
# Run it by hand or from cron, e.g. daily at 03:00:  0 3 * * * /path/to/deploy/simple/backup.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
docker compose exec -T web tar czf - -C /data . > "backups/suhbat-$(date +%F).tar.gz"
# Keep the last 14 backups.
ls -1t backups/suhbat-*.tar.gz | tail -n +15 | xargs -r rm --
echo "Backup written to $PWD/backups"
