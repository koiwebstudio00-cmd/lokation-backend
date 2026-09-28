# Arquitectura — Backend de la Plataforma Inmobiliaria (VPS)

**Cliente:** Koi Studio · **Fecha:** Julio 2026 · **Versión:** 1.1 · **Revisión:** 2026-09-13
**Docs relacionados:** `plan-mvp-backend.md`, `diagrama-er.md`, `permisos-rls.md`, `api-spec.md`, `webhooks.md`, `onboarding.md`

## 1. Visión

Backend API REST multi-tenant para la plataforma SaaS inmobiliaria, desplegado en VPS propio (Hostinger). Reemplaza a Supabase como backend del MVP actual de Lamelas y da soporte a la etapa SaaS: roles, CRM de leads, export de datos para sitios de clientes y webhooks. El frontend (Next.js) pasa a ser cliente de esta API. **Fuera de alcance por ahora:** facturación, subdominios/dominios custom, sitio público (fase posterior).

## 2. Stack

| Capa | Tecnología | Motivo |
|---|---|---|
| Runtime | Node.js 22 LTS + TypeScript | Un solo lenguaje con el front; tipos compartidos |
| Framework | Express 5 | Máxima experiencia del equipo, arranque rápido; el orden lo pone la estructura por módulos |
| ORM / migraciones | Prisma | Tipado fuerte; migraciones SQL custom para RLS |
| Validación | Zod | Compartible con el front; schemas por endpoint |
| Base de datos | PostgreSQL 17 (local en VPS) | Multi-tenant por `tenant_id` + RLS |
| Auth | JWT propio en cookies httpOnly (access + refresh rotativo), bcrypt, CSRF | Independencia total de proveedores; inmune a XSS vs localStorage |
| Storage | Cloudflare R2 (S3-compatible), presigned URLs | Fotos fuera del disco del VPS |
| Emails | nodemailer (SMTP, proveedor a elección) | Invitaciones, reset de contraseña, notificación de leads |
| Log de requests | morgan | Una línea por request; formato `dev` en local, `combined` en producción |
| Docs API | Markdown (`docs/api-spec.md`) | Contrato revisado contra rutas y schemas; no hay OpenAPI generado hoy |
| Proxy / SSL | Dokploy / Traefik en el entorno actual | Terminación HTTPS fuera del proceso Express |
| Orquestación | Imagen multi-stage + Dokploy | `Dockerfile` de producción; Compose local solo ofrece Postgres opcional |
| CI/CD | Integración de deploy del entorno | Build de imagen, migraciones en entrypoint y healthcheck |
| Tests | Vitest + supertest (integración contra Postgres de test) | RLS se prueba con tests de integración |

## 3. Topología de despliegue

```text
Internet → proxy HTTPS de Dokploy/Traefik → contenedor API :3000
                                         → Postgres por red privada

Browser → URL presignada → Cloudflare R2
Zernio → /webhooks/zernio → cola Postgres → worker → n8n
API → SMTP/Resend y webhooks salientes desde workers/servicios
```

El proceso arranca con `docker-entrypoint.sh`: aplica migraciones usando
`DATABASE_URL_MIGRATE` y después sirve la API con `DATABASE_URL` como `app_rt`.
Postgres no debe exponerse a internet. Las fotos no atraviesan el proceso Node.

## 4. Multi-tenancy y autorización

- **Una sola BD, `tenant_id` en toda tabla de negocio** (modelo ya validado en el MVP).
- **RLS de Postgres es la autorización real.** Sin `auth.uid()` de Supabase, el contexto se inyecta por variables de sesión: cada request corre dentro de una transacción que ejecuta `SET LOCAL app.user_id / app.tenant_id / app.rol` (tomados del JWT verificado) antes de cualquier query. Detalle en `permisos-rls.md`.
- La API se conecta con un rol de BD **sin `BYPASSRLS`** (`app_rt`). Migraciones corren con un rol privilegiado separado (`app_owner`).
- El check de rol en handlers (middleware `requireRole`) es UX/fail-fast; la garantía es RLS.

## 5. Estructura del repo (`back-lamelas`)

```
src/
  app.ts                 # build de Express, registro de middlewares
  server.ts              # entrypoint
  middleware/            # logging (morgan), auth (JWT cookies), tenant-context (tx + SET LOCAL), csrf, cors, errors
  modules/
    auth/                # login, refresh, reset, registro por invitación
    tenants/             # CRUD tenants (super admin), tenant actual
    users/               # equipo, invitaciones, roles
    properties/          # CRUD, estado comercial (alta visible al instante, sin aprobación)
    images/              # presign R2, portada, orden
    crm/                 # leads web/manual/WhatsApp, asignación, toma y seguimiento
    agent/               # conversaciones, tools, resúmenes, round-robin y handoffs
    integrations/        # API keys, cuentas de canal y webhook/worker Zernio
    analytics/           # métricas de CRM y Sofía
    feedback/            # sugerencias y reportes del panel
    export/              # datos públicos para sitios (API key)
    webhooks/            # outbox saliente, entregas y firma HMAC
  lib/                   # prisma, r2, mailer (nodemailer), errors, pagination
prisma/
  schema.prisma
  migrations/            # incluye SQL custom: RLS, triggers, enums
test/
Dockerfile               # imagen multi-stage de producción
docker-entrypoint.sh     # migraciones owner → proceso app_rt
docker-compose.yml       # Postgres local opcional
```

Cada módulo: `routes.ts` (rutas + schemas Zod) · `service.ts` (lógica) · `repo.ts` (queries). Sin lógica de negocio en rutas. Módulo `billing` **excluido por ahora** (el modelo lo soporta a futuro; no se construye).

## 6. Flujo de un request autenticado

1. Proxy HTTPS → Express. Middleware auth lee el access token de la **cookie httpOnly**, verifica firma/expiración y extrae `user_id`, `tenant_id`, `rol`. Mutations exigen header CSRF (double-submit).
2. Middleware tenant-context abre transacción Prisma y ejecuta los `SET LOCAL`.
3. Handler valida input con Zod → service → repo (queries dentro de la transacción).
4. RLS filtra/permite según `permisos-rls.md`. Errores → formato uniforme (`api-spec.md` §2).
5. Commit. Eventos de dominio se encolan para webhooks (outbox, ver `webhooks.md`).

## 7. Fotos (R2)

1. `POST /v1/properties/:id/images/presign` → valida límite (20) y permisos → devuelve presigned PUT URL con key `{tenant_id}/{property_id}/{uuid}.webp`.
2. El browser redimensiona client-side (máx. 1600px, WebP — igual que el MVP) y sube directo a R2.
3. `POST /v1/properties/:id/images/confirm` registra la fila (portada automática si es la primera).
4. Servido vía dominio público de R2 con caché de Cloudflare. El VPS nunca recibe bytes de imagen.

## 8. Migración desde Supabase (Lamelas)

1. **Datos:** `pg_dump` de Supabase → transformar (`auth.users` → `users` propios; los usuarios definen nueva contraseña vía flujo de reset) → import.
2. **Fotos:** copia bucket `property-images` → R2 con `rclone`; reescritura de URLs en `property_images`.
3. **Corte:** ventana corta, front apuntando a la nueva API. Rollback: Supabase queda intacto hasta validar.
4. Detalle operativo en `plan-mvp-backend.md` F5.

## 9. Decisiones y descartes

- **API separada vs Next full-stack:** separada — desacopla front/back, mantiene un contrato HTTP explícito y permite futuros clientes (app móvil, portales, export).
- **Express vs Nest vs Fastify:** Express 5 — es donde el equipo tiene más experiencia y prioriza velocidad de arranque; la disciplina de estructura (módulos routes/service/repo) compensa lo que Express no impone. Nest quedó descartado por curva/boilerplate para un solo dev.
- **Auth propia (JWT + cookies httpOnly) vs Auth.js vs managed:** propia — Auth.js es Next-céntrico y la API debe autenticar a cualquier cliente; managed (Clerk/Auth0) agrega dependencia y costo por usuario, contra el objetivo de independencia en VPS. Cookies httpOnly en vez de localStorage: inmune a XSS; CSRF cubierto por double-submit token.
- **Prisma vs Drizzle:** Prisma por familiaridad y tipado; RLS y triggers viven en SQL de migraciones (Prisma no los modela, no importa).
- **Contenedor vs PM2:** imagen Docker desplegada por Dokploy — build reproducible, healthcheck y migraciones controladas en el entrypoint. Compose queda como ayuda local para Postgres.
- **Log de requests: morgan (2026-07-27).** Una línea por request, montada primera en `buildApp()` para que también queden registradas las que rebotan por CORS o payload grande. Formato `dev` en local, `combined` (Apache) en producción, sin salida en `test`. Se saltea `/v1/health` porque el monitoreo lo pega cada pocos segundos y tapa el resto. Detalle no obvio: el filtro compara contra `req.originalUrl`, no `req.path` — morgan evalúa `skip` cuando la respuesta termina y para ese momento Express 5 dejó `req.url` reescrito con la ruta relativa al router (`/health`). Alcanza para el MVP; si más adelante hace falta log estructurado (JSON, correlación por request-id, envío a un agregador), se reemplaza por `pino-http` sin tocar los módulos.
- **Sin colas externas (Redis) en MVP:** webhooks salientes usan outbox y los eventos entrantes de Zernio usan `channel_webhook_events`; ambos tienen workers internos. Redis solo si el volumen lo exige.
- **Sin subdominios/dominios custom por ahora:** el routing por tenant en el sitio público se define cuando se construya esa fase. Nada en el modelo lo bloquea.
- **Sin billing por ahora:** sin tabla `subscriptions` ni límites de plan. Se agrega con migración cuando exista la necesidad comercial.
