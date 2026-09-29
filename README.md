# Ubikka · backend

API y workers de Ubikka. Este repositorio Git local se creó a partir del estado de trabajo de un prototipo técnico y no tiene remoto configurado.

Node/Express, Prisma y PostgreSQL. Mantener el aislamiento con tenant_id y RLS, y agregar pruebas con dos tenants cuando cambien permisos. Las migraciones existentes y los contratos HTTP son la base técnica; cualquier referencia a marca, dominios o políticas comerciales del prototipo es heredada.

El `docker-compose.yml` usa el nombre de proyecto `ubikka` y publica PostgreSQL en `localhost:5433`, separado de otros proyectos llamados `backend`. Para preparar datos ficticios locales: `docker compose up -d --wait db`, `npm run db:migrate:deploy` y `npm run seed`.

El documento [README.legacy.md](README.legacy.md) y los documentos importados describen el prototipo original y se conservan solo como referencia técnica. Plan vigente: [PLAN_IMPLEMENTACION.md](../docs/PLAN_IMPLEMENTACION.md).
