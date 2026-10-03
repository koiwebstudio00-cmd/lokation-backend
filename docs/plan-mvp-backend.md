# Plan MVP — Backend + BD en VPS

> **Plan histórico.** Las fases y estimaciones documentan el desarrollo inicial;
> para el comportamiento implementado usar `api-spec.md`, `arquitectura.md`,
> `diagrama-er.md`, `permisos-rls.md` y `webhooks.md`.

**Objetivo:** API REST multi-tenant (Express 5 + TS) desplegada en el VPS Hostinger, con CRM de leads, módulo export para sitios de clientes, webhooks, y Lamelas migrada desde Supabase como tenant fundador.
**Referencia:** `arquitectura.md`, `diagrama-er.md`, `permisos-rls.md`, `api-spec.md`, `webhooks.md`, `onboarding.md`
**Modo de trabajo:** desarrollo asistido por agente (Claude Code), checkpoints verificables por fase. No avanzar con el checkpoint roto.

## Estado actual (27/07/2026)

**El orden de ejecución cambió respecto del plan original:** el despliegue (F3.5) se movió al final. Se termina y prueba todo en local contra datos reales migrados, y recién después se sube al VPS. El motivo es que un corte de Supabase con el backend a medias no tiene rollback barato.

Orden vigente: (1) VPS básico ✅ · (2) backend local ✅ · (3) migrar datos reales de Supabase ✅ · (4) conectar la web pública `lamelas-web` ✅ · (5) migrar el panel `lamelas` de Supabase a la API · (6) integración completa en local · (7) deploy con Dokploy.

Hecho hasta acá, además de las fases 0 a 4: script `scripts/migrate-supabase.ts` (idempotente, corre por el **session pooler** de Supabase porque la conexión directa es IPv6-only) y `scripts/admin-cli.ts`, que resuelve el bloqueo de arranque — todos los usuarios se importan como `agente` con contraseña irrecuperable y todavía no hay SMTP, así que sin un CLI privilegiado no había forma de crear el primer admin ni, por lo tanto, la primera API key. En producción se usa desde la consola del contenedor en Dokploy (ver `onboarding.md` §7).

`lamelas-web` ya no depende de Supabase: consume `/v1/export/*` con `X-Api-Key` desde el navegador y el formulario de contacto da de alta leads por `POST /v1/public/:tenant_slug/leads`. La key viaja en el bundle a propósito (endpoint de solo lectura, acotado al tenant, sin campos internos y revocable en un minuto), igual que antes viajaba la anon key.

27/07: log de requests con **morgan** (`src/middleware/logging.ts`), montado primero en `buildApp()`; formato `dev` en local y `combined` en producción, sin salida en `test`, salteando `/v1/health`. Es lo mínimo para poder mirar qué le entra a la API una vez que esté en el VPS — detalle de la decisión en `arquitectura.md` §9.

Diferido por decisión, no olvidado: `GET /admin/metrics`, UI de suspensión de tenants, job de limpieza y el `Dockerfile` (tiene que correr `prisma migrate deploy` con la URL de owner al arrancar y después servir la app como `app_rt`).


## Fase 0 — Fundaciones (100% local, 0.5 semanas)

- Repo `back-lamelas`: Express 5 + TS + Prisma + Zod, estructura de módulos (`arquitectura.md` §5), lint/tsc/vitest corriendo local.
- Desarrollo contra **Postgres 17 instalado localmente** (sin Docker en dev); `docker-compose.yml` queda en el repo solo como base del stack de producción (F3.5). Misma versión 17 local y en VPS para evitar sorpresas.
- Migración inicial: enums, tablas core (`tenants`, `users`), helpers `ctx_*()`, roles de BD `app_owner`/`app_rt`.
- Seed local y Postgres de test para la suite de integración.

**Nota:** VPS, Caddy, deploy y backups se difieren a la Fase 3.5 — no hay nada que deployar todavía y Compose garantiza que dev y prod sean el mismo entorno. R2 y SMTP sí se usan desde dev (F2/F3) con buckets/keys de desarrollo.

**Checkpoint:** `GET /health` OK en local; migración aplicada; un test de integración de ejemplo en verde.

## Fase 1 — Auth, tenants y equipo (2 semanas)

- Auth completa: login/refresh/logout con **cookies httpOnly + CSRF**, forgot/reset password (nodemailer/SMTP), bcrypt, rate limiting. (`api-spec.md` §3)
- Middleware tenant-context (transacción + `SET LOCAL`) y `requireRole`.
- CRUD tenants (super admin) + invitaciones + gestión de equipo (`api-spec.md` §4–5), flujo de onboarding §1–3.
- Migración: `invitations`, `refresh_tokens`, `password_resets` + **todas las policies RLS de estas tablas con sus tests de integración** (`permisos-rls.md` §6).
- Seed: super admin Koi + tenant de prueba.

**Checkpoint:** ciclo completo por API: super admin crea tenant → admin acepta invitación → invita agente → agente entra. Tests RLS de aislamiento entre 2 tenants en verde.

## Fase 2 — Propiedades y fotos, sin fricción (2 semanas)

- CRUD propiedades con filtros/búsqueda/paginación + "mine" con contadores (`api-spec.md` §6) — **tabla idéntica al MVP de Lamelas + `link_maps` opcional** (link de Google Maps).
- **Sin flujo de aprobación** (decisión de producto): el alta queda visible al público de inmediato, igual que en el MVP.
- Imágenes por R2 presigned (presign/confirm/portada/orden/delete), límite 20, borrado consistente BD+R2 — mismo flujo que el MVP (resize client-side → subida directa → registro con portada automática), cambiando Supabase Storage por R2.
- Policies RLS de `properties`/`property_images`/tests: admin edita todo su tenant, agente solo lo suyo, tenant ajeno invisible, `public` ve el inventario del tenant sin campos internos.

**Checkpoint:** agente crea → sube fotos → visible con contexto public al instante; segundo tenant no ve nada. Suite RLS completa en verde.

## Fase 3 — CRM de leads y webhooks (1.5 semanas)

- Módulo CRM (`api-spec.md` §8): alta pública desde formulario web (rate limit + honeypot) y alta manual; asignación al agente → email (nodemailer); estados (`nueva → en_contacto → ganada/perdida`), reasignación, notas de seguimiento, stats por estado/canal.
- Modelo multicanal listo (`canal`, `canal_ref`) — conectores WhatsApp/IG/Messenger quedan para después sin cambio de esquema.
- Sistema de webhooks completo: registro, outbox transaccional, worker con reintentos, firma HMAC, deliveries consultables, test/ping (`webhooks.md`).
- Policies RLS de `leads`/`lead_notes` + tests.

**Checkpoint:** lead creado desde curl llega por email al agente, aparece en `GET /leads`, se gestiona (estado + nota) y dispara `lead.created` a un endpoint n8n de prueba; reintento verificado apagando el receptor. (Todo esto corre en local; webhooks salientes y el envío de emails funcionan desde dev.)

## Fase 3.5 — Despliegue en VPS (0.5 semanas)

Momento elegido: ya hay producto real que probar contra infra real, y las fases siguientes (export consumido por sitios externos, QA de migración) se validan mejor con URL pública.

- Contratar/preparar VPS: hardening (firewall 80/443/SSH, SSH por clave, fail2ban, unattended-upgrades), Docker.
- Compose de producción (+ Caddy con `api.plataforma.com` y SSL).
- Despliegue manual en Dokploy: verificar → construir imagen → migrar → comprobar salud.
- Backups: `pg_dump` diario → R2 + **prueba de restore documentada** (obligatoria antes de F5: sin restore probado no se migra a Lamelas).
- Smoke test del flujo completo de F1–F3 contra producción.

**Checkpoint:** `GET /health` OK en producción con SSL; un push a `main` llega solo a prod; backup restaurado con éxito.

## Fase 4 — Módulo export y super admin (1 semana)

- API keys por tenant (crear/listar/revocar; hash en BD, key visible una sola vez).
- Endpoints export (`api-spec.md` §9): propiedades del tenant con filtros + `updated_since`, ficha, datos del sitio. Rate limit por key, CORS, cache. Sin campos internos — test explícito de que `notas`/`user_id` no se filtran.
- `GET /admin/metrics`, suspensión de tenants; tenant suspendido: sesiones y API keys dejan de operar.
- Job de limpieza (deliveries > 30 días, invitaciones vencidas, resets usados).

**Checkpoint:** un sitio estático de prueba consume `/export/properties` con su key; key revocada → 401; tenant suspendido no puede operar.

## Fase 5 — Migración de Lamelas y corte (1.5 semanas)

- Scripts de migración: export Supabase → transform → import (usuarios, propiedades, imágenes); `rclone` bucket → R2; reescritura de URLs. Ensayo completo contra copia antes del corte real.
- Emails de reset a usuarios de Lamelas; designar admin (`onboarding.md` §4).
- **Adaptación del front actual:** reemplazar clientes Supabase por cliente de la API (cookies + CSRF, fetch de propiedades, upload presigned). Es el trabajo más invasivo en el repo del front — planificarlo con su propio checklist.
- QA en celular real del flujo completo contra producción nueva. Supabase en solo-lectura 1 semana como rollback; después, baja.

**Checkpoint final:** vendedores de Lamelas operando 100% contra el VPS sin pérdida de datos ni fotos.

## Resumen

| Fase | Contenido | Duración | Entorno |
|---|---|---|---|
| 0 | Fundaciones: repo + Compose + schema | 0.5 sem | Local |
| 1 | Auth (cookies) + tenants + equipo | 2 sem | Local |
| 2 | Propiedades + fotos sin fricción | 2 sem | Local (R2 dev) |
| 3 | CRM de leads + webhooks | 1.5 sem | Local (SMTP dev) |
| 3.5 | Despliegue: VPS + CI/CD + backups | 0.5 sem | Prod |
| 4 | Export + super admin | 1 sem | Prod |
| 5 | Migración Lamelas + corte | 1.5 sem | Prod |
| **Total** | | **~9 semanas** (1 dev + agente) |

## Fuera de alcance de este plan

Facturación/planes (sin tabla `subscriptions`; se agrega por migración cuando toque), subdominios y dominios custom, front del sitio público, conectores de leads WhatsApp/Instagram/Messenger (el modelo ya los soporta), sync con portales (el contrato de webhooks ya lo soporta), app móvil.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| RLS por `SET LOCAL` mal aplicado (query fuera de la transacción) | Todo acceso a BD pasa por el middleware tenant-context; test que falla si una query corre sin contexto |
| Express sin estructura impuesta → módulos inconsistentes | Convención routes/service/repo obligatoria (CLAUDE.md regla 6); review por fase |
| Fuga de datos internos por export | Selects dedicados sin campos internos + test explícito por endpoint público |
| Corte de migración con datos perdidos | Ensayo completo previo + Supabase en rollback 1 semana |
| VPS único = punto único de falla | Backups diarios probados + snapshots; restore documentado < 1 h |
| Adaptación del front subestimada | Checklist propio en F5; mantener contratos de datos idénticos al MVP donde sea posible |
| Scope creep hacia billing/sitio público/canales de chat | Fuera de alcance explícito; el modelo ya los soporta, no se construyen |
