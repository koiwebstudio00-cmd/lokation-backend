# back-lamelas

Backend API REST multi-tenant de la plataforma inmobiliaria (Koi Studio).
Express 5 + TypeScript + Prisma + Postgres 17 (RLS). Documentación en `docs/`.

## Requisitos

Node 22+ y PostgreSQL 17 instalado localmente (sin Docker en desarrollo).

## Arranque local

```bash
cp .env.example .env        # ajustar credenciales de tu Postgres local; JWT_SECRET: openssl rand -hex 32
createdb inmo
createdb inmo_test
npm install
npm run db:generate
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/inmo?schema=public" npx prisma migrate deploy
npm run seed
npm run dev                 # http://localhost:3000/v1/health
```

La migración corre con tu usuario privilegiado (crea roles, funciones y policies RLS); la app se conecta como `app_rt`, sin BYPASSRLS.

## Tests

```bash
npm test                    # usa inmo_test (DATABASE_URL_TEST)
```

## Producción

La imagen de producción se construye con `Dockerfile` y arranca mediante
`docker-entrypoint.sh`, que aplica migraciones con el rol owner antes de servir
la API como `app_rt`. El procedimiento operativo vigente está en
`docs/deploy-runbook.md` y `docs/paso-a-paso-dokploy.md`.

## Reglas

Ver `CLAUDE.md` / `AGENTS.md`. Las importantes: RLS es la autorización real; toda query pasa por `runWithContext`; la app se conecta como `app_rt` (sin BYPASSRLS); cambios de BD = migración nueva.
