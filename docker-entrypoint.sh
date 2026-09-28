#!/bin/sh
# Arranque en producción: primero migrar, después servir.
#
# Las migraciones necesitan un rol privilegiado (crean tablas, policies, roles);
# la API corre como `app_rt`, que NO tiene BYPASSRLS. Por eso son dos URLs
# distintas y la de owner solo se usa en este paso.
set -e

if [ -z "$DATABASE_URL_MIGRATE" ]; then
  echo "[entrypoint] Falta DATABASE_URL_MIGRATE (rol owner de la BD)." >&2
  echo "[entrypoint] Sin eso no se pueden aplicar migraciones. Ver docs/plan-despliegue-vps.md." >&2
  exit 1
fi

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] Falta DATABASE_URL (rol app_rt)." >&2
  exit 1
fi

echo "[entrypoint] Aplicando migraciones pendientes..."
DATABASE_URL="$DATABASE_URL_MIGRATE" ./node_modules/.bin/prisma migrate deploy

# `exec` para que node quede como PID 1 y reciba el SIGTERM de Docker: sin esto
# los deploys terminan matando el proceso a lo bruto en vez de cerrar limpio.
echo "[entrypoint] Migraciones al día. Levantando la API como app_rt."
exec node dist/server.js
