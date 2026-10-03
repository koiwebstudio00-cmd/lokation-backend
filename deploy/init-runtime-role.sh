#!/bin/sh
# Sólo se ejecuta al inicializar un volumen PostgreSQL vacío.
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --set=runtime_password="$APP_RT_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE app_rt LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'runtime_password') \gexec
SQL
