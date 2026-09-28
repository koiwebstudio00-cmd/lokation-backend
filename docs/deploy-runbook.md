# Runbook de deploy — back-lamelas en el VPS con Dokploy

**Fecha:** 2026-07-28 · **Estado de partida:** VPS levantado, Dokploy instalado, nada deployado.
**Complementa** a `plan-despliegue-vps.md` (que tiene el plan completo, incluidos los pasos 0 y 1 ya hechos). Esto es la parte que queda, con los nombres exactos del repo tal como está hoy.

---

## 0. Lo que este repo ya trae (nuevo, 2026-07-28)

| Archivo | Para qué |
|---|---|
| `Dockerfile` | Build en dos etapas. En Dokploy elegir **Build Type: Dockerfile** |
| `docker-entrypoint.sh` | Corre `prisma migrate deploy` con el rol owner y después arranca la API como `app_rt` |
| `.dockerignore` | Que no viajen `node_modules`, `.env` ni los tests al build |
| `scripts/bootstrap-prod.sql` | Crear `app_rt` con password fuerte, **una sola vez, antes del primer deploy** |

---

## 1. Antes de tocar Dokploy

- [ ] **DNS**: registro A `api.inmobiliarialyc.com.ar` → IP del VPS. Verificar con `dig +short api.inmobiliarialyc.com.ar`. Sin esto no hay certificado.
- [ ] **Repo en GitHub** (privado) con `main` al día — Dokploy deploya desde ahí.
- [ ] **R2**: buckets `lamelas-prod` (público) y `lamelas-backups` (privado) + token Object Read & Write.
- [x] **SMTP**: host, puerto, usuario, password y remitente. **Configurado con Resend en prod (02/08/2026), envío verificado a inbox.** Sin `SMTP_HOST` los emails se loggean a consola y nadie se entera de nada.
- [ ] Generar los secretos en la Mac:

```bash
openssl rand -hex 32      # JWT_SECRET
openssl rand -base64 32   # password de app_rt
openssl rand -base64 32   # password del owner de la BD (la genera Dokploy)
```

---

## 2. Base de datos

1. Dokploy → proyecto `lamelas` → **Database → PostgreSQL 17**, nombre `inmo`. **No publicar puerto**: la API entra por la red interna de Docker. (Recordá: Docker saltea `ufw`, un puerto publicado queda expuesto a internet aunque el firewall no lo liste.)
2. Terminal del contenedor → `psql -U <owner> -d inmo` → pegar `scripts/bootstrap-prod.sql` con la password de `app_rt` reemplazada.

**El orden importa.** La migración 0001 crea `app_rt` con la password de desarrollo `app_rt_dev`, pero solo si el rol no existe. Creándolo antes con una password fuerte, la migración lo respeta y se limita a darle permisos. Al revés, producción arranca con la password de dev.

---

## 3. La aplicación

**Build Type:** Dockerfile · **Puerto:** 3000 · **Dominio:** `api.inmobiliarialyc.com.ar` con HTTPS (Traefik emite el certificado solo).

### Variables de entorno

```bash
NODE_ENV=production
PORT=3000

# Dos URLs distintas, a propósito:
# app_rt corre la API y NO puede saltarse RLS. El owner solo migra.
DATABASE_URL=postgresql://app_rt:<pass_app_rt>@<host_interno_db>:5432/inmo?schema=public
DATABASE_URL_MIGRATE=postgresql://<owner>:<pass_owner>@<host_interno_db>:5432/inmo?schema=public

JWT_SECRET=<openssl rand -hex 32>
COOKIE_SECURE=true
COOKIE_SAMESITE=lax                    # ver §4
COOKIE_DOMAIN=.inmobiliarialyc.com.ar  # ver §4
CORS_ORIGIN=https://panel.inmobiliarialyc.com.ar,https://inmobiliarialyc.com.ar

FRONT_URL=https://panel.inmobiliarialyc.com.ar

R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=lamelas-prod
R2_PUBLIC_URL=https://<dominio-publico-del-bucket>

SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=Lamelas & Chaumont <no-reply@inmobiliarialyc.com.ar>

# Agente de IA
HANDOFF_TIMEOUT_MIN=60
LABORAL_DESDE=9
LABORAL_HASTA=19
LABORAL_DIAS=1,2,3,4,5
TZ_OFFSET_HORAS=-3
SITIO_PUBLICO_URL=https://inmobiliarialyc.com.ar
```

`<host_interno_db>` es el nombre del servicio de Postgres dentro de Dokploy, no `localhost` ni la IP pública.

> **La app se niega a arrancar** en producción sin `JWT_SECRET`, sin `CORS_ORIGIN` o con `COOKIE_SECURE` en false. Es a propósito: los tres son fallas silenciosas si arrancara igual. Si el deploy no levanta, mirá los logs — el mensaje dice exactamente cuál falta.

### Deploy

Deploy → seguir los logs. Tenés que ver:

```
[entrypoint] Aplicando migraciones pendientes...
12 migrations found in prisma/migrations
[entrypoint] Migraciones al día. Levantando la API como app_rt.
```

**Checkpoint:** `curl https://api.inmobiliarialyc.com.ar/v1/health` → `{"ok":true,"db":"up"}` con certificado válido.

---

## 4. La trampa de las cookies (leer antes de configurar)

La sesión del panel viaja en cookies `httpOnly`. Dónde vive el panel cambia la configuración:

**Si el panel queda en `panel.inmobiliarialyc.com.ar`** (dominio propio apuntando a Vercel) — el panel y la API son *el mismo sitio* aunque sean orígenes distintos:

```
COOKIE_SAMESITE=lax
COOKIE_DOMAIN=.inmobiliarialyc.com.ar
```

**Si el panel queda en `algo.vercel.app`** — son sitios distintos y el navegador **no manda la cookie**, así que el login no funciona nunca:

```
COOKIE_SAMESITE=none    # obliga a COOKIE_SECURE=true, que ya está
COOKIE_DOMAIN=          # vacío
```

El síntoma de equivocarse es feo de diagnosticar: el login devuelve 200, y el request siguiente 401. Si te pasa, es esto.

La primera opción es mejor: `SameSite=none` desactiva una protección real contra CSRF (queda solo el double-submit token) y algunos navegadores con bloqueo de cookies de terceros la rechazan igual.

---

## 5. Auto-deploy

Activar **Auto Deploy** en la app. Probar con un commit trivial a `main` y ver el redeploy en los logs. Cada deploy corre las migraciones pendientes solo.

---

## 6. Backups con restore probado

**Sin restore probado no se migra Lamelas.** No es una formalidad: un backup que nunca se restauró es un backup que no sabés si sirve.

1. Dokploy → **S3 Destinations** → R2 (endpoint, keys, bucket `lamelas-backups`).
2. BD `inmo` → backup diario a las 03:00 hacia ese destino.
3. Correr uno manual **ahora** y verificar que el archivo aparece en R2.
4. **Restore de prueba**: crear `inmo_restore_test`, restaurar el dump ahí, comparar conteos, borrar la BD de prueba.

```sql
-- Comparar en las dos bases:
select 'tenants' t, count(*) from tenants
union all select 'users', count(*) from users
union all select 'properties', count(*) from properties
union all select 'leads', count(*) from leads
union all select 'conversations', count(*) from conversations
union all select 'conversation_messages', count(*) from conversation_messages;
```

5. Anotar cuánto tardó y el procedimiento en `RESTORE.md`. Objetivo: menos de 1 hora.

---

## 7. Smoke test contra producción

Además del smoke test del plan original (login, tenant, propiedad + foto real a R2, lead público, webhook, aislamiento entre tenants), ahora hay que probar lo nuevo:

```bash
API=https://api.inmobiliarialyc.com.ar

# 1. Salud
curl -s $API/v1/health

# 2. Crear la key del agente desde el panel (Configuración → Integraciones),
#    con scopes agent:read y agent:write. Después:
KEY=ilk_...

# 3. La tool de búsqueda: tiene que traer propiedades reales y NUNCA `notas`
curl -s "$API/v1/agent/properties?q=departamento" -H "x-api-key: $KEY" | grep -c notas   # → 0

# 4. Abrir una conversación de prueba
curl -s -X POST $API/v1/agent/conversations -H "x-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"canal":"whatsapp","canal_ref":"+5493810000000","nombre":"Prueba deploy"}'

# 5. Como admin, verificar que aparece en /consultas con canal WhatsApp.
#    Como vendedor debe permanecer oculta hasta que el agente haga el handoff.

# 6. La key del sitio público NO debe entrar al agente
curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/agent/properties" \
  -H "x-api-key: <key_del_sitio>"    # → 403
```

Y la verificación que más importa, en la terminal de la BD:

```sql
select rolname, rolsuper, rolbypassrls from pg_roles where rolname = 'app_rt';
```

Tiene que dar **false, false**. Si alguno diera true, RLS no está protegiendo nada y hay que frenar el corte: toda la autorización del sistema depende de ese rol.

Al terminar: borrar el lead y la conversación de prueba.

---

## 8. Después del deploy

1. Apuntar `lamelas` (panel) y `lamelas-web` a `https://api.inmobiliarialyc.com.ar` y desplegarlos.
2. Correr la migración de datos con datos frescos (`npm run migrate:supabase`).
3. Dejar Supabase en read-only una semana como rollback.
4. Recién ahí, el agente en n8n — que ya tiene contra qué hablar.
