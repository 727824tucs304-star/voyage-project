#!/usr/bin/env bash
# Removes legacy customers after they have been archived in the admin console.
#   Dry run (default):   scripts/cleanup-legacy-clients.sh msn,xyz,globalpens
#   Execute (after you have reviewed the plan and typed DELETE when asked):
#                        scripts/cleanup-legacy-clients.sh msn,xyz,globalpens --execute
# Protected customers are never touched. Everything is backed up before anything is deleted.
set -euo pipefail

PROTECTED="adhoc"
LIST_ARG="${1:-}"
MODE="${2:-}"
[ -n "$LIST_ARG" ] || { echo "usage: $0 slug1,slug2 [--execute]"; exit 1; }

IFS=',' read -ra SLUGS <<< "$LIST_ARG"
for s in "${SLUGS[@]}"; do
  [[ "$s" =~ ^[a-z][a-z0-9]{2,30}$ ]] || { echo "REFUSED: '$s' is not a valid workspace name"; exit 1; }
  for p in $PROTECTED; do
    [ "$s" = "$p" ] && { echo "REFUSED: '$s' is protected and will not be touched"; exit 1; }
  done
done

psql_ctl() { sudo docker exec -i voyage-postgres psql -U voyage_admin -v ON_ERROR_STOP=1 "$@"; }
BACKUP="$HOME/voyage-backups/legacy-cleanup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"

echo "== PLAN (nothing changes in this step)"
for s in "${SLUGS[@]}"; do
  echo
  echo "--- workspace: $s"
  psql_ctl -d voyage_control -c "SELECT slug, company_name, product, version, status, archived_at FROM tenants WHERE slug = '$s';"
  psql_ctl -d voyage_control -At -c "SELECT 'usage rows: ' || COUNT(*) FROM usage_daily WHERE slug = '$s';"
  psql_ctl -d voyage_control -At -c "SELECT 'billing summaries: ' || COUNT(*) FROM billing_summaries WHERE slug = '$s';"
  psql_ctl -d voyage_control -At -c "SELECT 'deployment records: ' || COUNT(*) FROM deployments WHERE slug = '$s';"
  echo "resources:"
  echo "  database  : tenant_$s   role: tenant_$s"
  echo "  container : voyage-tenant-$s  ($(sudo docker inspect -f '{{.State.Status}}' voyage-tenant-$s 2>/dev/null || echo 'not present'))"
  echo "  volume    : vespera-files-$s  ($(sudo docker volume inspect vespera-files-$s >/dev/null 2>&1 && echo present || echo 'not present'))"
  echo "  nginx     : /etc/nginx/tenants/$s.conf  ($(sudo docker exec voyage-nginx test -f /etc/nginx/tenants/$s.conf && echo present || echo 'not present'))"
done

if [ "$MODE" != "--execute" ]; then
  echo
  echo "DRY RUN COMPLETE. Nothing was changed. Review the plan above, then run again with --execute."
  exit 0
fi

echo
echo "This permanently deletes the databases, containers, files and records listed above."
echo "Backups will be written to: $BACKUP"
read -r -p "Type DELETE to confirm: " ANSWER
[ "$ANSWER" = "DELETE" ] || { echo "Cancelled. Nothing changed."; exit 1; }

for s in "${SLUGS[@]}"; do
  echo "== $s: backing up"
  psql_ctl -d voyage_control -c "\copy (SELECT * FROM tenants WHERE slug = '$s') TO STDOUT CSV HEADER" > "$BACKUP/$s-tenant-row.csv"
  sudo docker exec voyage-postgres pg_dump -U voyage_admin "tenant_$s" > "$BACKUP/$s-database.sql"
  if sudo docker volume inspect "vespera-files-$s" >/dev/null 2>&1; then
    sudo docker run --rm -v "vespera-files-$s:/data:ro" -v "$BACKUP:/backup" alpine tar czf "/backup/$s-files.tgz" -C /data .
  fi

  echo "== $s: stopping and removing its container"
  sudo docker rm -f "voyage-tenant-$s" >/dev/null 2>&1 || true

  echo "== $s: removing control-plane records (one transaction)"
  psql_ctl -d voyage_control <<SQL
BEGIN;
DELETE FROM billing_summaries WHERE slug = '$s';
DELETE FROM usage_daily WHERE slug = '$s';
DELETE FROM deployments WHERE slug = '$s';
DELETE FROM tenants WHERE slug = '$s';
COMMIT;
SQL

  echo "== $s: dropping database, role and routing"
  psql_ctl -d postgres -c "DROP DATABASE IF EXISTS \"tenant_$s\";"
  psql_ctl -d postgres -c "DROP ROLE IF EXISTS \"tenant_$s\";"
  sudo docker volume rm "vespera-files-$s" >/dev/null 2>&1 || true
  sudo docker exec voyage-nginx rm -f "/etc/nginx/tenants/$s.conf"
  sudo docker exec voyage-nginx nginx -t >/dev/null && sudo docker exec voyage-nginx nginx -s reload
  echo "== $s: removed"
done
echo
echo "Done. Backups are in $BACKUP"
