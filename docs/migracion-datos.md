# Migración de datos: Supabase → producción

---

## Paso 1 — Usar el tenant que ya existe

El script arma el tenant destino. Por defecto usa un id fijo pensado para una base vacía, pero vos ya creaste el tuyo desde la API, así que le decimos que use ese.

En psql, buscá el id:

```sql
select id, nombre, slug from tenants;
```

Copialo. Lo vas a poner como `MIGRATE_TENANT_ID` en el paso 3, y con eso el script escribe todos los usuarios, propiedades y fotos dentro de tu tenant. No hay que borrar nada.

**Un detalle que conviene tener claro:** ese id queda metido dentro de las keys de las fotos en R2 (`{tenant_id}/{property_id}/{archivo}`) y en las URLs guardadas en la base. Si más adelante quisieras cambiar de tenant, habría que resubir todas las fotos. O sea que la decisión de qué id usar es ahora.

El script además chequea antes de escribir: si encuentra un tenant con el slug `lamelas` y otro id distinto al destino, corta con un mensaje claro en vez de reventar con un error de unicidad.

Tu usuario admin ya existe dentro de ese tenant, así que **el paso 5 podés saltearlo** salvo que quieras crear otro.

---

## Paso 2 — Abrir un túnel a la base de producción

El script corre en tu Mac y tiene que escribir en la base del VPS, que no está expuesta a internet (y así tiene que seguir). Un túnel SSH la deja accesible solo para vos, mientras la terminal esté abierta.

**Averiguá la IP interna del contenedor:**

```bash
ssh root@76.13.226.2 "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' \$(docker ps -qf name=lamelas-inmo)"
```

Te va a devolver algo tipo `172.18.0.5`.

**Abrí el túnel** (dejá esta terminal abierta todo el tiempo que dure la migración):

```bash
ssh -N -L 5433:172.18.0.5:5432 root@76.13.226.2
```

No va a imprimir nada. Eso está bien: significa que está funcionando.

**En otra terminal, probá que llegás:**

```bash
psql "postgresql://inmo_owner:LA_PASSWORD_DEL_OWNER@localhost:5433/inmo" -c "select count(*) from users;"
```

Si responde, el túnel anda: tu `localhost:5433` es la base de producción.

---

## Paso 3 — Configurar el .env

En `~/koi/clients/back-lamelas/.env`, dejá estas variables:

```bash
# ⚠️ APUNTA A PRODUCCIÓN — revertir apenas termine la migración
DATABASE_URL_MIGRATE=postgresql://inmo_owner:LA_PASSWORD_DEL_OWNER@localhost:5433/inmo?schema=public

# El tenant que ya creaste (paso 1)
MIGRATE_TENANT_ID=el-uuid-de-tu-tenant

# Origen: Supabase → Project Settings → Database → Connection string (URI)
SUPABASE_DB_URL=postgresql://postgres:...@db.xxxx.supabase.co:5432/postgres
SUPABASE_PROJECT_URL=https://xxxx.supabase.co

# Destino de las fotos: el bucket de producción
R2_ACCOUNT_ID=tu_account_id
R2_ACCESS_KEY_ID=la_key_de_lamelas-prod
R2_SECRET_ACCESS_KEY=el_secret_de_lamelas-prod
R2_BUCKET=lamelas-prod
R2_PUBLIC_URL=https://pub-xxxxxxxx.r2.dev
```

**Guardá aparte el valor viejo de `DATABASE_URL_MIGRATE`** (el de tu Postgres local). Mientras esa línea apunte a producción, cualquier `prisma migrate` que corras en tu Mac va contra el servidor real.

Usá las credenciales de R2 de `lamelas-prod`, no las de backups.

---

## Paso 4 — Correr la migración

```bash
cd ~/koi/clients/back-lamelas
npm run migrate:supabase
```

Vas a ver algo así:

```
── Migración Supabase → back-lamelas ──
Tenant 'lamelas' OK (00000000-0000-0000-0000-000000000001)
Usuarios: 5 en origen, 5 importados (todos 'agente'), 0 ya existían
Propiedades: 98 en origen, 98 importadas, 0 ya existían
  foto 1: 00000000-.../xxxx/foto.jpg (245 KB)
  ...
Fotos: 312 en origen, 312 migradas a R2, 0 ya existían, 0 con error
✔ Migración completa sin errores.
```

**El script es idempotente**: si falla a la mitad, lo volvés a correr y retoma solo lo que falta. No duplica nada.

Si hay errores en las fotos, los lista al final. Volvé a correrlo: reintenta solo esas.

---

## Paso 5 — Recrear tu usuario admin

Todos los usuarios de Supabase entran como `agente` con una contraseña aleatoria que nadie conoce — cada vendedor define la suya por el flujo de "olvidé mi contraseña", que **ya funciona: el SMTP está configurado con Resend en producción (02/08/2026)**.

Vos necesitás un admin ya. Dos opciones:

**A — Promover a uno de los importados** (si tu mail estaba en Supabase):

```sql
update users set rol = 'admin' where email = 'tu@email.com';
```

Pero después vas a necesitar la contraseña, así que igual tenés que hashear una:

```bash
cd ~/koi/clients/back-lamelas
node -e "require('bcrypt').hash('TuClave',12).then(h=>console.log(h))"
```

```sql
update users set password_hash = 'EL_HASH' where email = 'tu@email.com';
```

**B — Crear uno nuevo** (si tu mail no estaba):

```sql
insert into users (tenant_id, nombre, email, password_hash, rol, estado)
values ('00000000-0000-0000-0000-000000000001', 'Joaquín Medina',
        'joaquinmedinadev0@gmail.com', 'EL_HASH', 'admin', 'activo');
```

---

## Paso 6 — Verificar

En el panel, en incógnito, con el usuario admin:

- Las propiedades aparecen en `/propiedades`
- **Las fotos se ven** — si salen rotas, es el `NEXT_PUBLIC_R2_HOST` de Vercel: tiene que ser el hostname público de `lamelas-prod`
- El equipo aparece en `/equipo`, todos como vendedores

Y en psql, los conteos:

```sql
select 'users' t, count(*) from users
union all select 'properties', count(*) from properties
union all select 'property_images', count(*) from property_images;
```

---

## Paso 7 — Cerrar

1. Cortá el túnel SSH (Ctrl+C en esa terminal).
2. **Volvé a poner el `DATABASE_URL_MIGRATE` local en el `.env`.**
3. Correr un backup manual desde Dokploy, ahora con los datos reales.
4. Bajarlo y hacer el restore de prueba otra vez — **esta es la que importa**, la anterior fue con la base vacía.
