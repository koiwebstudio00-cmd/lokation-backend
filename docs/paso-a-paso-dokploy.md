# Levantar la app en Dokploy — paso a paso

Seguí esto de arriba a abajo. Cada paso dice dónde hacer clic y qué escribir.

---

## Antes de empezar: la planilla de valores

Vas a necesitar 6 datos. Abrí un archivo de texto y andá completándolo — los vas a pegar todos juntos al final.

```
1. HOST INTERNO DE LA BASE ......  (lo da Dokploy en el paso 2)
2. USUARIO OWNER DE LA BASE .....  (lo elegís vos en el paso 2)
3. PASSWORD DEL OWNER ...........  (la genera Dokploy en el paso 2)
4. PASSWORD DE app_rt ...........  (la generás vos, abajo)
5. JWT_SECRET ...................  (lo generás vos, abajo)
6. CREDENCIALES DE R2 ...........  (ya las tenés)
```

Los dos que generás vos, en la terminal de tu Mac:

```bash
openssl rand -base64 32   # → esta es la PASSWORD DE app_rt (4)
openssl rand -hex 32      # → este es el JWT_SECRET (5)
```

Copiá las dos salidas a la planilla. Son solo texto aleatorio; no significan nada, solo tienen que ser difíciles de adivinar.

---

## Paso 1 — Asegurate de que GitHub esté al día

En la terminal:

```bash
cd ~/koi/clients/back-lamelas
git status --short
```

Si aparecen archivos listados, todavía no subiste nada y el deploy va a fallar. Subilo:

```bash
npm test
git add -A
git commit -m "modulos integrations y agent + deploy: Dockerfile, entrypoint y bootstrap de prod"
git push origin main
```

Si `git status --short` no muestra nada, ya está.

---

## Paso 2 — Crear la base de datos

En Dokploy:

1. **Create Project** → nombre: `lamelas`
2. Dentro del proyecto: **Create Service** → **Database** → **PostgreSQL**
3. Completá:
   - **Name:** `inmo`
   - **Database Name:** `inmo`
   - **User:** `inmo_owner`
   - **Password:** usá el botón de generar, o pegá una tuya
   - **Docker Image:** `postgres:17` ← escribilo **exactamente así**, todo en
     minúscula y con dos puntos. Si ponés "PostgreSQL 17" el deploy falla con
     `invalid reference format: repository name must be lowercase`.
     Usá `postgres:17` y no `postgres:17-alpine`: la variante alpine ordena el
     texto con otra librería del sistema, y restaurar un backup entre variantes
     distintas puede dejarte índices inconsistentes.
4. **Create** y esperá a que arranque (queda en verde)
5. **No toques nada de "External Port" ni "Expose".** La app va a llegar por la red interna de Docker. Si publicás el puerto, tu base queda abierta a internet — y ojo que Docker se saltea el firewall, así que `ufw` no te va a salvar.

**Anotá en la planilla:**

- **(1) HOST INTERNO:** en la página de la base, Dokploy muestra una *Internal Connection URL* con esta forma:
  `postgresql://inmo_owner:xxxx@ALGO:5432/inmo`
  Ese `ALGO` del medio es el host interno. Copiá esa palabra.
- **(2) USUARIO OWNER:** `inmo_owner`
- **(3) PASSWORD DEL OWNER:** la que generaste ahí

---

## Paso 3 — El bootstrap de la base (importante: antes de crear la app)

1. En la página de la base, buscá la **Terminal** (o "Console")
2. Ejecutá:

```bash
psql -U inmo_owner -d inmo
```

3. Vas a ver un prompt `inmo=#`. Pegá esta línea, reemplazando por tu **PASSWORD DE app_rt (4)**:

```sql
create role app_rt login password 'ACA_VA_LA_PASSWORD_DEL_PUNTO_4';
```

4. Tiene que responder `CREATE ROLE`. Salí con `\q`

**Por qué esto va antes:** las migraciones crean el usuario `app_rt` con una password de desarrollo que está publicada en el repo, pero solo si el usuario no existe todavía. Creándolo vos primero con una password fuerte, las migraciones lo respetan.

---

## Paso 4 — Crear la aplicación

1. En el proyecto `lamelas`: **Create Service** → **Application**
2. **Provider:** GitHub → conectá tu cuenta si te lo pide
3. **Repository:** `koiwebstudio00-cmd/back-lamela` ← ojo, **sin la "s"** final
4. **Branch:** `main`
5. **Build Type:** **Dockerfile** (no Nixpacks, no Buildpacks)
6. **Dockerfile Path:** `Dockerfile`
7. Guardá

---

## Paso 5 — Las variables de entorno

En la aplicación → pestaña **Environment**. Hay un cuadro de texto grande. Pegá **todo** este bloque y después reemplazá los `<...>` con los valores de tu planilla:

```
NODE_ENV=production
PORT=3000

DATABASE_URL=postgresql://app_rt:<4_PASSWORD_APP_RT>@<1_HOST_INTERNO>:5432/inmo?schema=public
DATABASE_URL_MIGRATE=postgresql://<2_USUARIO_OWNER>:<3_PASSWORD_OWNER>@<1_HOST_INTERNO>:5432/inmo?schema=public

JWT_SECRET=<5_JWT_SECRET>
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
COOKIE_DOMAIN=.inmobiliarialyc.com.ar
CORS_ORIGIN=https://panel.inmobiliarialyc.com.ar,https://inmobiliarialyc.com.ar
FRONT_URL=https://panel.inmobiliarialyc.com.ar

R2_ACCOUNT_ID=<tu_account_id>
R2_ACCESS_KEY_ID=<tu_access_key>
R2_SECRET_ACCESS_KEY=<tu_secret>
R2_BUCKET=lamelas-prod
R2_PUBLIC_URL=<url_publica_del_bucket>

HANDOFF_TIMEOUT_MIN=60
LABORAL_DESDE=9
LABORAL_HASTA=19
LABORAL_DIAS=1,2,3,4,5
TZ_OFFSET_HORAS=-3
SITIO_PUBLICO_URL=https://inmobiliarialyc.com.ar
```

**El SMTP ya está puesto (Resend, 02/08/2026).** Las variables `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=587`, `SMTP_USER=resend`, `SMTP_PASS=<api-key>` y `EMAIL_FROM` están cargadas en prod y el envío está verificado. (Si faltaran, los emails se escriben en los logs en vez de enviarse y la app arranca igual.)

### Qué es cada cosa

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Cómo se conecta la API a la base, **con el usuario limitado** `app_rt`. Este usuario no puede saltarse las reglas de seguridad por fila: es lo que impide que un cliente vea datos de otro |
| `DATABASE_URL_MIGRATE` | La misma base pero con el usuario dueño. Se usa **solo** al arrancar, para crear tablas. Son dos usuarios distintos a propósito |
| `JWT_SECRET` | La clave con la que se firman las sesiones. Si se filtra, cualquiera puede falsificar un login |
| `COOKIE_SECURE=true` | Las cookies solo viajan por HTTPS |
| `COOKIE_SAMESITE` / `COOKIE_DOMAIN` | Hacen que la cookie de sesión funcione entre `panel.` y `api.` del mismo dominio |
| `CORS_ORIGIN` | Qué sitios web pueden llamar a la API desde el navegador. Sin esto, cualquier página de internet podría hacer pedidos con la sesión de tus usuarios |
| `FRONT_URL` | La base de los links que van en los emails (invitaciones, reset de contraseña) |
| `R2_*` | Dónde se guardan las fotos de las propiedades |
| `LABORAL_*`, `HANDOFF_TIMEOUT_MIN` | El horario de atención y los 60 minutos antes de reasignar una derivación del agente |

---

## Paso 6 — El dominio

En la aplicación → pestaña **Domains** → **Add Domain**:

- **Host:** `api.inmobiliarialyc.com.ar`
- **Path:** `/`
- **Container Port:** `3000`
- **HTTPS:** activado
- **Certificate Provider:** Let's Encrypt

Guardá. El certificado se emite solo en menos de un minuto.

---

## Paso 7 — Deploy

Botón **Deploy**. Abrí la pestaña de **Logs** y mirá.

Lo que tenés que ver, en orden:

```
[entrypoint] Aplicando migraciones pendientes...
12 migrations found in prisma/migrations
Applying migration ...
[entrypoint] Migraciones al día. Levantando la API como app_rt.
```

Si aparece eso, lo difícil ya pasó.

**La prueba final**, desde tu terminal:

```bash
curl https://api.inmobiliarialyc.com.ar/v1/health
```

Tiene que devolver:

```json
{"ok":true,"db":"up"}
```

---

## Si algo falla

| Lo que dice el log | Qué pasó | Cómo se arregla |
|---|---|---|
| `Dockerfile not found` | No pusheaste a GitHub | Paso 1 |
| `JWT_SECRET es obligatorio en producción` | Falta esa variable | Paso 5 |
| `CORS_ORIGIN es obligatorio en producción` | Ídem | Paso 5 |
| `COOKIE_SECURE debe ser 'true'` | Ídem | Paso 5 |
| `Falta DATABASE_URL_MIGRATE` | Ídem | Paso 5 |
| `password authentication failed for user "app_rt"` | Te salteaste el paso 3, o la password no coincide | **No cambies el `DATABASE_URL`.** Entrá a la terminal de la base y corré `alter role app_rt password '<la del punto 4>';` |
| `Can't reach database server at ...` | El host interno está mal | Revisá el valor (1); no es `localhost` ni una IP pública |
| `Error: connect ECONNREFUSED` durante el build | Normal si el build corre antes de que la base arranque | Esperá que la base esté en verde y redeployá |
| `invalid reference format: repository name must be lowercase` | El nombre de la imagen de Docker está mal escrito | Poné `postgres:17`, en minúscula y sin espacios |
| No abre la consola ni hay logs | El servicio está creado pero nunca se desplegó | Tocá **Deploy** y esperá el verde |

Si ves algo que no está en esta tabla, copiame el log y lo miramos.
