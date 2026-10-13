#!/usr/bin/env bash
set -euo pipefail
umask 077

LXC=/snap/bin/lxc
BACKUP_DIR=${DEVVM_BACKUP_DIR:-/var/backups/dev-instance-manager}
RETENTION_DAYS=${DEVVM_BACKUP_RETENTION_DAYS:-7}
[[ -x "$LXC" ]] || { echo "LXD CLI not found at $LXC" >&2; exit 1; }
[[ "$RETENTION_DAYS" =~ ^[1-9][0-9]?$ ]] || { echo "Retention must be 1-99 days" >&2; exit 1; }

install -d -o root -g root -m 0700 "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mapfile -t instances < <("$LXC" list --format=json | python3 -c '
import json,sys
for item in json.load(sys.stdin):
    if item.get("name","").startswith("dev-"):
        print(item["name"])
')
if [[ ${#instances[@]} -eq 0 ]]; then
  echo "No dev-* instances found; nothing to back up."
  exit 0
fi

for name in "${instances[@]}"; do
  target="$BACKUP_DIR/${name}-${stamp}.tar.gz"
  temp="$BACKUP_DIR/.${name}-${stamp}.partial.tar.gz"
  echo "Exporting $name ..."
  rm -f -- "$temp"
  if "$LXC" export "$name" "$temp"; then
    mv -- "$temp" "$target"
    chmod 0600 "$target"
    echo "Saved $target"
  else
    rm -f -- "$temp"
    echo "Backup failed for $name" >&2
    exit 1
  fi
done

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'dev-*.tar.gz' -mtime +"$RETENTION_DAYS" -print -delete
