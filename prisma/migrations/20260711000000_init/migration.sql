-- 0001 init — enums, tablas core, helpers de contexto, roles de BD y RLS.
-- Referencia: docs backend (diagrama-er.md, permisos-rls.md).
-- Corre con rol privilegiado (DATABASE_URL_MIGRATE). La app usa app_rt (sin BYPASSRLS).

-- ── Extensiones ──────────────────────────────────────────────────────────────
create extension if not exists citext;
create extension if not exists pgcrypto;

-- ── Enums ────────────────────────────────────────────────────────────────────
create type tenant_estado as enum ('activo', 'suspendido');
create type user_rol as enum ('super_admin', 'admin', 'agente');
create type user_estado as enum ('activo', 'inactivo');

-- ── Tablas core ──────────────────────────────────────────────────────────────
create table tenants (
  id            uuid primary key default gen_random_uuid(),
  nombre        text not null,
  slug          text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'),
  logo_url      text,
  config_sitio  jsonb,
  estado        tenant_estado not null default 'activo',
  created_at    timestamptz not null default now()
);

create table users (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid references tenants(id), -- null solo para super_admin
  nombre         text not null,
  email          citext not null unique,
  password_hash  text not null,
  rol            user_rol not null,
  estado         user_estado not null default 'activo',
  created_at     timestamptz not null default now(),
  -- super_admin sin tenant; admin/agente siempre con tenant
  constraint users_tenant_por_rol check (
    (rol = 'super_admin' and tenant_id is null)
    or (rol <> 'super_admin' and tenant_id is not null)
  )
);

create index idx_users_tenant_email on users (tenant_id, email);

-- ── Helpers de contexto (seteados por el middleware tenant-context) ─────────
create function ctx_user_id() returns uuid language sql stable as
  $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create function ctx_tenant_id() returns uuid language sql stable as
  $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create function ctx_rol() returns text language sql stable as
  $$ select coalesce(nullif(current_setting('app.rol', true), ''), 'none') $$;

create function is_super_admin() returns boolean language sql stable as
  $$ select ctx_rol() = 'super_admin' $$;

-- ── Rol de la aplicación (sin BYPASSRLS) ─────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_rt') then
    -- Password de desarrollo; en prod se cambia por ALTER ROLE (ver docs F3.5).
    create role app_rt login password 'app_rt_dev';
  end if;
end $$;

grant usage on schema public to app_rt;
grant select, insert, update, delete on all tables in schema public to app_rt;
alter default privileges in schema public grant select, insert, update, delete on tables to app_rt;
grant execute on all functions in schema public to app_rt;
alter default privileges in schema public grant execute on functions to app_rt;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table tenants enable row level security;
alter table users enable row level security;

-- tenants: super_admin ve todos; miembros ven el suyo
create policy tenants_select on tenants for select using (
  is_super_admin() or id = ctx_tenant_id()
);

create policy tenants_insert on tenants for insert with check (is_super_admin());

-- super_admin todo; admin solo su tenant (branding/config — columnas acotadas
-- por el service; RLS garantiza la fila)
create policy tenants_update on tenants for update using (
  is_super_admin() or (ctx_rol() = 'admin' and id = ctx_tenant_id())
) with check (
  is_super_admin() or id = ctx_tenant_id()
);

create policy tenants_delete on tenants for delete using (is_super_admin());

-- users: visibles dentro del mismo tenant; super_admin todos
create policy users_select on users for select using (
  is_super_admin() or (tenant_id is not null and tenant_id = ctx_tenant_id())
);

-- alta: super_admin, o admin dentro de su tenant y nunca creando super_admins
create policy users_insert on users for insert with check (
  is_super_admin()
  or (ctx_rol() = 'admin' and tenant_id = ctx_tenant_id() and rol <> 'super_admin')
);

-- edición: el propio usuario, o admin sobre su tenant (sin tocar super_admins)
create policy users_update on users for update using (
  is_super_admin()
  or id = ctx_user_id()
  or (ctx_rol() = 'admin' and tenant_id = ctx_tenant_id() and rol <> 'super_admin')
) with check (
  is_super_admin() or (tenant_id is not null and tenant_id = ctx_tenant_id())
);

-- sin delete: la baja es users.estado = 'inactivo'
