#!/usr/bin/env bash
# Ensayo local: vuelca ubikka_dev (solo lectura) y restaura en una BD temporal.
# Nunca restaura sobre la base de origen ni borra su volumen Docker.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! docker compose ps --status running --services | grep -qx db; then
  echo "PostgreSQL local no está en ejecución. Iniciá: docker compose up -d db" >&2
  exit 1
fi

source_db="ubikka_dev"
restore_db="ubikka_restore_$(date +%Y%m%d_%H%M%S)_${RANDOM}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/ubikka-restore.XXXXXXXX")"
restore_created=0

cleanup() {
  if [ "$restore_created" -eq 1 ]; then
    docker compose exec -T db dropdb -U postgres --if-exists "$restore_db" || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

db_query() {
  docker compose exec -T db psql -U postgres -d "$1" -At -c "$2"
}

if [ "$(db_query postgres "select count(*) from pg_database where datname = '$source_db'")" != 1 ]; then
  echo "No existe $source_db en el contenedor local." >&2
  exit 1
fi
if [ "$(db_query postgres "select count(*) from pg_database where datname = '$restore_db'")" != 0 ]; then
  echo "La base temporal ya existe; no se sobrescribirá." >&2
  exit 1
fi
if [ "$(db_query "$source_db" "select count(distinct tenant_id) from properties")" -lt 2 ]; then
  echo "El ensayo requiere propiedades de al menos dos tenants en $source_db." >&2
  exit 1
fi

echo "Creando backup local de $source_db..."
docker compose exec -T db pg_dump -U postgres -d "$source_db" -Fc > "$work_dir/backup.dump"
test -s "$work_dir/backup.dump"
docker compose exec -T db createdb -U postgres -T template0 "$restore_db"
restore_created=1
docker compose exec -T db pg_restore -U postgres -d "$restore_db" --exit-on-error < "$work_dir/backup.dump"

# Conteos de entidades críticas, migraciones y políticas RLS. El dump custom
# preserva también grants, índices y restricciones; pg_restore falla si no.
counts_sql="select (select count(*) from tenants),
  (select count(*) from users),
  (select count(*) from properties),
  (select count(*) from property_images),
  (select count(*) from leads),
  (select count(*) from conversations),
  (select count(*) from channel_accounts),
  (select count(*) from webhook_deliveries),
  (select count(*) from _prisma_migrations),
  (select count(*) from pg_policies where schemaname = 'public')"
source_counts="$(db_query "$source_db" "$counts_sql")"
restore_counts="$(db_query "$restore_db" "$counts_sql")"
source_tenants="$(db_query "$source_db" "select string_agg(slug, ',' order by slug) from tenants")"
restore_tenants="$(db_query "$restore_db" "select string_agg(slug, ',' order by slug) from tenants")"

if [ "$source_counts" != "$restore_counts" ] || [ "$source_tenants" != "$restore_tenants" ]; then
  echo "La copia restaurada no coincide con el origen." >&2
  echo "Origen: $source_counts [$source_tenants]" >&2
  echo "Copia:  $restore_counts [$restore_tenants]" >&2
  exit 1
fi

# La copia también debe conservar permisos y policies efectivos para app_rt.
# SET ROLE elimina los privilegios de postgres en estas consultas.
while IFS='|' read -r tenant_id expected_ids; do
  visible_ids="$(docker compose exec -T db psql -U postgres -d "$restore_db" -Atq -c \
    "SET ROLE app_rt; SET app.rol = 'public'; SET app.tenant_id = '$tenant_id'; SELECT coalesce(string_agg(id::text, ',' order by id::text), '') FROM properties;")"
  if [ "$visible_ids" != "$expected_ids" ]; then
    echo "RLS no coincide para tenant $tenant_id: esperado [$expected_ids], visible [$visible_ids]" >&2
    exit 1
  fi
done < <(db_query "$restore_db" \
  "select t.id, coalesce(string_agg(p.id::text, ',' order by p.id::text), '')
   from tenants t left join properties p on p.tenant_id = t.id
   group by t.id order by t.id")

echo "Restauración verificada. Tenants: $restore_tenants"
echo "Conteos (tenants, users, properties, images, leads, conversations, channels, deliveries, migrations, RLS policies): $restore_counts"
echo "La base temporal y el archivo de backup se eliminarán al finalizar."
