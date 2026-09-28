-- Bootstrap de producción — correr UNA sola vez, ANTES del primer deploy.
--
-- Dónde: Dokploy → proyecto lamelas → base de datos `inmo` → terminal del
-- contenedor → `psql -U <usuario_owner> -d inmo`, y pegar esto.
--
-- Por qué existe: la migración 0001 crea el rol `app_rt` con una password de
-- desarrollo ('app_rt_dev'), pero solo si el rol NO existe todavía. Creándolo
-- acá primero, con una password fuerte, la migración lo respeta y se limita a
-- darle los permisos. Si se corriera al revés, producción quedaría con la
-- password de desarrollo.
--
-- Generar la password en la Mac:  openssl rand -base64 32
-- Reemplazarla abajo Y usar la misma en el DATABASE_URL de Dokploy.

create role app_rt login password 'REEMPLAZAR_POR_PASSWORD_FUERTE';

-- Si el rol ya existía (por ejemplo, porque las migraciones corrieron antes),
-- usar esto en lugar de la línea de arriba:
--
--   alter role app_rt password 'REEMPLAZAR_POR_PASSWORD_FUERTE';

-- ── Verificación ─────────────────────────────────────────────────────────────
-- Después del primer deploy, confirmar que app_rt quedó como corresponde:
--
--   select rolname, rolsuper, rolbypassrls from pg_roles where rolname = 'app_rt';
--
-- Tiene que devolver rolsuper = false y rolbypassrls = false.
-- Si alguno diera true, RLS no está protegiendo nada y hay que frenar el corte:
-- toda la autorización del sistema depende de que este rol NO pueda saltarse
-- las policies.
--
-- Y que las policies estén activas en las tablas con datos de clientes:
--
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' and tablename in
--     ('leads','properties','conversations','conversation_messages','users');
--
-- Las cinco tienen que dar rowsecurity = true.

-- Todo lo demás — grants, RLS, tablas, índices — lo aplican las migraciones.
-- No agregar nada acá que pueda vivir en una migración.
