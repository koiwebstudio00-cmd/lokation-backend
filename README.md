# Ubikka · backend

API y workers de Ubikka. Este repositorio Git local se creó a partir del estado de trabajo de un prototipo técnico y no tiene remoto configurado.

Node/Express, Prisma y PostgreSQL. Mantener el aislamiento con tenant_id y RLS, y agregar pruebas con dos tenants cuando cambien permisos. Las migraciones existentes y los contratos HTTP son la base técnica; cualquier referencia a marca, dominios o políticas comerciales del prototipo es heredada.

El `docker-compose.yml` usa el nombre de proyecto `ubikka` y publica PostgreSQL en `localhost:5433`, separado de otros proyectos llamados `backend`. Para preparar datos ficticios locales: `docker compose up -d --wait db`, `npm run db:migrate:deploy` y `npm run seed`.

El documento [README.legacy.md](README.legacy.md) y los documentos importados describen el prototipo original y se conservan solo como referencia técnica. Plan vigente: [PLAN_IMPLEMENTACION.md](../docs/PLAN_IMPLEMENTACION.md).

## Dashboard: contratos nuevos · 2026-10-01

- `GET /v1/properties/locations`: devuelve `{ zonas, ciudades }` del inventario visible del tenant (hasta 200 valores por campo), bajo autenticación y RLS.
- `PATCH /v1/properties/:id`: acepta `punto_referencia` nullable, máximo 200 caracteres; Prisma lo representa como `puntoReferencia`.
- Listados de propiedades: `zona_revisar=true` filtra zona nula o vacía; combina con búsqueda y los filtros existentes.
- `GET /v1/leads?atencion=true`: filtra derivaciones pendientes. Lista/detalle exponen `derivacion` con `motivo`, `pendiente` y `asignado_at`, o null. La búsqueda de pendientes no se pierde si existe una conversación posterior.
- Analíticas admin-only por tenant: `overview`, `leads`, `sofia` (nombre histórico del contrato) y `properties` bajo `/v1/analytics`. Se agregaron comparación anterior, distribuciones y métricas de inventario. El dashboard muestra “Agente IA”.
- Las fechas deben ser válidas; rangos de 1 a 366 días. Un mes completo se compara con el mes calendario anterior; otros rangos, con igual cantidad de días inmediatamente anteriores.

### Migración y pruebas

Migración aditiva `20261002010000_property_reference`: agrega `properties.punto_referencia`. Aplicada localmente a desarrollo y test. En otro entorno, ejecutar `npm run db:generate` y el procedimiento de migraciones correspondiente antes de publicar el dashboard.

Local: `npm run db:migrate:deploy`; test: `npm run test:prepare` y `npm test`. La suite general pasó con 263 pruebas durante la integración; después se ampliaron y verificaron propiedades (17), CRM (27) y analíticas (10). Ubicaciones y atención incluyen comprobaciones con dos tenants. Build y lint también pasaron.

## Actualización: correos, notificaciones y web pública

Ver [guía de implementación y pruebas](../docs/CORREOS_NOTIFICACIONES_WEB.md).
Resend opcional con `RESEND_API_KEY` y `EMAIL_FROM`; notificaciones personales con RLS y migración `20261003000000_notifications`.

## Almacenamiento de imágenes en VPS

Disponible `STORAGE_DRIVER=local`: conserva presign/PUT/confirm y guarda imágenes en un directorio persistente. Configurar `LOCAL_STORAGE_DIR` y `LOCAL_STORAGE_URL` (URL pública del backend terminada en `/media`). Ver [despliegue VPS](../docs/DESPLIEGUE_VPS.md) para volumen, proxy, copias y prueba del piloto. R2 sigue siendo el valor por defecto; no migra imágenes ya guardadas.

La imagen de PostgreSQL de `compose.production.yml` se construye desde `deploy/postgres.Dockerfile` e incluye el script de inicialización. No requiere montajes de scripts en la interfaz de Dokploy.
