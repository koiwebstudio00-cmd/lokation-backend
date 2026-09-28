# Plan de despliegue — Fase 3.5 (VPS Hostinger + Dokploy)

**Objetivo del finde:** `GET /health` OK en producción con SSL, push a `main` deploya solo, backup restaurado con éxito.
**Herramienta elegida:** **Dokploy** (panel open source autoalojado). Trae incluido: proxy con SSL automático (Traefik, no hay que configurarlo a mano), deploy desde GitHub sin escribir workflows, gestión de bases de datos y backups a S3/R2 desde la UI. Reemplaza al Compose manual + Caddy + GitHub Actions del plan original de F3.5 — mismo checkpoint, menos piezas nuevas que aprender.
**Estado al 2026-07-24:** VPS contratado ✅ · dominio existe, falta registro DNS · sin R2 prod, sin SMTP prod, sin SSH configurado, repo aún no en GitHub.

---

## Orden de ejecución actualizado (2026-07-25)

Decisión de Cacho: el deploy va al **final**, con todo probado en local primero. El VPS se deja levantado y esperando. Secuencia:

1. **VPS básico** (ya): SO + IP + hardening (Paso 1 de este plan) + Dokploy instalado. Nada deployado.
2. **Backend local — export esencial**: API keys por tenant + endpoints `/export` (la parte de F4 que necesita la web; métricas/suspensión de super admin quedan para después del corte).
3. **Migración de datos real (adelantada de F5):** script export Supabase → import BD local + fotos a R2 con reescritura de URLs. Se prueba con los datos reales de Lamelas y queda ensayado para el corte. Requiere crear el bucket R2 antes de lo previsto.
4. **`lamelas-web` → backend local**: consume `/export/properties` con la API key de Lamelas (mismo mecanismo que usarán otros clientes); el formulario de contacto pasa a enviar al alta pública de leads del CRM (hoy no envía a ningún lado).
5. **Front admin `lamelas` → backend local (adelantado de F5):** reemplazar clientes Supabase por la API (cookies + CSRF, fetch, upload presigned). Es el trabajo más invasivo — checklist propio.
6. **Pruebas integrales en local** (admin + web + emails + fotos) hasta que todo ande perfecto.
7. **Subir todo al VPS**: Pasos 2–5 de este plan (BD + API en Dokploy, auto-deploy, backups con restore, smoke test) + apuntar los fronts a la URL de producción + corte final desde Supabase (re-corrida del script de migración con datos frescos).

Los pasos 0.3 (R2), 0.4 (SMTP) y 0.5 (GitHub) siguen vigentes pero se necesitan antes: R2 para el punto 3, GitHub para el punto 7, SMTP puede esperar al punto 6–7 (en dev los emails se loggean a consola).

---

## Paso 0 — Prerrequisitos (viernes)

Todo lo de este paso desbloquea el resto. El DNS conviene hacerlo **primero** (propagación).

### 0.1 Acceso SSH al VPS
- [ ] En hPanel: anotar la **IP pública**; SO recomendado **Ubuntu 24.04 LTS**.
- [ ] Clave en la Mac: `ssh-keygen -t ed25519 -C "vps-lamelas" -f ~/.ssh/vps_lamelas`
- [ ] Cargar la clave pública en hPanel y probar: `ssh -i ~/.ssh/vps_lamelas root@IP_DEL_VPS`

### 0.2 DNS (hacer ya)
- [ ] Registro **A**: `api.<tu-dominio>` → IP del VPS (para la API).
- [ ] Registro **A**: `panel.<tu-dominio>` → IP del VPS (para entrar a Dokploy con SSL en vez de `IP:3000`).
- [ ] Verificar: `dig +short api.<tu-dominio>` devuelve la IP. Sin esto no hay certificado SSL.

### 0.3 Cloudflare R2
- [ ] Crear bucket `lamelas-prod` (fotos; free tier 10 GB alcanza — estimado ~0,6 GB) con dominio público habilitado.
- [ ] Crear bucket `lamelas-backups` (privado).
- [ ] API token de R2 (Object Read & Write) → guardar `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY` y el endpoint `https://<account_id>.r2.cloudflarestorage.com`.

### 0.4 SMTP para nodemailer
Nodemailer (ya en el código) necesita credenciales de un servidor SMTP. Opciones — cualquiera funciona sin tocar código:
- **Resend vía SMTP**: host `smtp.resend.com`, user `resend`, pass = API key. Free: 100 emails/día.
- **Email de Hostinger**: si el plan incluye email del dominio, usar ese SMTP directamente.
- [ ] Elegir uno, guardar `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS`, remitente `no-reply@<tu-dominio>`.
- [ ] Configurar **SPF y DKIM** en el DNS (el proveedor da los registros) para que los emails no caigan en spam.

### 0.5 Repo en GitHub
- [ ] Crear repo privado `back-lamelas` y pushear `main`. Dokploy se conecta a este repo — no hace falta configurar nada de Actions.

---

## Paso 1 — Preparar el VPS e instalar Dokploy (sábado mañana, ~1 h)

Hardening mínimo (esto Dokploy no lo hace por vos, pero es corto):

- [ ] `apt update && apt upgrade -y`
- [ ] SSH (`/etc/ssh/sshd_config`): `PasswordAuthentication no` y `PermitRootLogin prohibit-password` (root solo por clave; si preferís, crear un usuario con sudo y poner `PermitRootLogin no`) → `systemctl restart ssh`. **Probar el login por clave en otra terminal antes de cerrar esta.**
- [ ] Firewall: `ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw allow 3000 && ufw enable`
- [ ] ⚠️ **Docker saltea ufw**: los puertos que un contenedor "publica" quedan abiertos a internet aunque ufw no los liste. Regla práctica: en Dokploy **nunca publicar puertos** en los servicios (ni BD ni API) — todo el tráfico entra por Traefik (80/443). El checklist del paso 2 ya respeta esto.
- [ ] `apt install -y fail2ban unattended-upgrades`

Instalar Dokploy (instala Docker solo si falta):

- [ ] `curl -sSL https://dokploy.com/install.sh | sh`
- [ ] Entrar **inmediatamente** a `http://IP:3000` y crear la cuenta admin (el primero que entra se queda con el panel — no dejarlo abierto sin cuenta).
- [ ] Activar **2FA** en la cuenta admin de Dokploy (Settings → Profile). El panel controla todo el VPS; es un minuto bien invertido.
- [ ] En Settings → Server: asignar el dominio `panel.<tu-dominio>` al panel (SSL automático). Cuando funcione por el dominio: `ufw delete allow 3000`.

**Checkpoint:** panel de Dokploy accesible por `https://panel.<tu-dominio>`, login solo por clave SSH, firewall solo 22/80/443.

---

## Paso 2 — Base de datos y API en Dokploy (sábado tarde, ~2–3 h)

Todo desde la UI de Dokploy:

- [ ] Crear proyecto `lamelas`.
- [ ] **Database → PostgreSQL 17**: nombre `inmo`, password fuerte generada. No exponer puerto externo — la API llega por la red interna de Docker.
- [ ] Conectarse una vez a la BD (desde la terminal del contenedor en Dokploy) para el bootstrap: crear roles `app_owner` / `app_rt` (script SQL del repo).
- [ ] **Application** desde GitHub: conectar la cuenta, elegir `back-lamelas`, rama `main`. Build: **Dockerfile** (lo escribimos juntos y queda en el repo; es la única pieza de código nueva que pide este plan).
- [ ] Cargar variables de entorno en la UI (verificar nombres exactos contra el `.env.example` del repo):
  - `DATABASE_URL` (rol `app_rt`, host = nombre interno del servicio de BD) y URL de migraciones (rol `app_owner`)
  - Secrets JWT (generar: `openssl rand -base64 48`), `NODE_ENV=production`, `CORS_ORIGIN`, dominio de cookies
  - R2: endpoint, keys, bucket, URL pública
  - SMTP: host, port, user, pass, from
- [ ] Migraciones: el comando de arranque corre `npx prisma migrate deploy` (con la URL owner) antes de levantar el server — así cada deploy migra solo.
- [ ] **Domains** de la app: `api.<tu-dominio>`, puerto 3000, HTTPS activado → Dokploy/Traefik emite el certificado solo.
- [ ] Deploy → ver logs en la UI hasta que levante.
- [ ] Seed mínimo de prod: solo el super admin real (no el seed de dev con `password123`).

**Checkpoint:** `curl https://api.<tu-dominio>/health` OK con certificado válido.

---

## Paso 3 — Auto-deploy (domingo mañana, ~15 min)

- [ ] En la app de Dokploy: activar **Auto Deploy** (usa el webhook/GitHub App de Dokploy — cero configuración de Actions).
- [ ] Probar: commit trivial → push a `main` → ver el redeploy automático en los logs del panel.

**Checkpoint:** un push a `main` llega solo a producción.

---

## Paso 4 — Backups con restore probado (domingo tarde, ~1–2 h)

Obligatorio antes de F5: **sin restore probado no se migra Lamelas.**

- [ ] Dokploy → **S3 Destinations**: agregar R2 (endpoint de 0.3, keys, bucket `lamelas-backups`).
- [ ] En la BD `inmo`: programar **backup diario** (03:00) hacia ese destino.
- [ ] Correr un backup manual ya y verificar que el archivo aparece en R2.
- [ ] **Prueba de restore**: crear una BD temporal `inmo_restore_test` → restaurar el dump (desde la UI de Dokploy o `pg_restore` en la terminal del contenedor) → verificar conteos de tablas clave → borrar la BD de prueba.
- [ ] Documentar el procedimiento y los tiempos en `RESTORE.md` del repo (objetivo: restore < 1 h).

**Checkpoint:** backup del día en R2 + restore verificado y documentado.

---

## Paso 5 — Smoke test F1–F3 contra producción (domingo, ~1 h)

Con curl/Postman contra `https://api.<tu-dominio>`:

- [ ] `GET /health` OK.
- [ ] Login super admin → crear tenant de prueba → invitación admin → aceptar → invitar agente (**verifica que los emails llegan de verdad** — revisar spam; si caen, repasar SPF/DKIM de 0.4).
- [ ] Agente crea propiedad → presign R2 → subir foto real → confirm → visible en contexto public al instante (verifica R2 prod end-to-end).
- [ ] Alta pública de lead por slug → email al agente → gestionar estado + nota.
- [ ] Webhook de prueba (n8n o webhook.site) → `lead.created` llega firmado.
- [ ] Aislamiento: segundo tenant no ve nada del primero.
- [ ] Borrar/suspender el tenant de prueba.

**Checkpoint final Fase 3.5:** todo en verde → listo para Fase 4.

---

## Cronograma

| Cuándo | Qué |
|---|---|
| Viernes | Paso 0 (DNS **ya**, SSH, R2, SMTP, repo a GitHub) |
| Sábado AM | Paso 1 — VPS + Dokploy |
| Sábado PM | Paso 2 — BD + API deployada con SSL |
| Domingo AM | Paso 3 — auto-deploy |
| Domingo PM | Pasos 4 y 5 — backups + restore + smoke test |

## Riesgos del finde

| Riesgo | Mitigación |
|---|---|
| DNS tarda en propagar | Crear los registros A el viernes, antes que todo |
| Panel Dokploy expuesto en `:3000` | Crear la cuenta admin apenas se instala; cerrar 3000 cuando funcione `panel.<dominio>` |
| Emails a spam | SPF/DKIM en 0.4; probar con Gmail real en el smoke test |
| Bloquearse del VPS al endurecer SSH | Probar el login nuevo en otra terminal antes de cerrar la actual |
| Nombres de env vars distintos a los del repo | Validar contra `.env.example` antes del paso 2 |
| Migraciones necesitan rol owner | Comando de arranque usa URL owner solo para `migrate deploy`; la app corre con `app_rt` |
| Docker abre puertos por fuera de ufw | Nunca publicar puertos en servicios de Dokploy; todo por Traefik |
| Robo de acceso al panel Dokploy | 2FA activado + panel solo por HTTPS con el puerto 3000 cerrado |
