-- 0004 properties — propiedades e imágenes, SIN flujo de aprobación.
-- Decisión de producto: la carga no tiene fricción — el agente registra la
-- propiedad y queda visible en el sitio público de inmediato (mismo flujo que
-- el MVP de Lamelas). Tabla idéntica a la del MVP + link_maps opcional.

-- ── Enums de negocio (mismos valores que el MVP) ─────────────────────────────
create type operacion_enum as enum ('venta', 'alquiler');
create type tipo_enum as enum ('casa', 'departamento', 'terreno', 'local', 'otro');
create type moneda_enum as enum ('ARS', 'USD');
create type estado_enum as enum ('disponible', 'reservada', 'vendida');

-- ── Tablas ───────────────────────────────────────────────────────────────────
create table properties (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  user_id        uuid not null references users(id),
  -- obligatorios
  titulo         text not null,
  operacion      operacion_enum not null,
  tipo           tipo_enum not null,
  precio         numeric(14,2) not null check (precio >= 0),
  moneda         moneda_enum not null default 'ARS',
  -- opcionales (mismos del MVP)
  descripcion    text,
  direccion      text,
  zona           text,
  ciudad         text,
  ambientes      smallint check (ambientes >= 0),
  dormitorios    smallint check (dormitorios >= 0),
  banios         smallint check (banios >= 0),
  sup_cubierta   numeric(10,2) check (sup_cubierta >= 0),
  sup_total      numeric(10,2) check (sup_total >= 0),
  estado         estado_enum not null default 'disponible',
  notas          text,
  -- nuevo: link de Google Maps (opcional)
  link_maps      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index idx_properties_tenant_created on properties (tenant_id, created_at desc);
create index idx_properties_tenant_user on properties (tenant_id, user_id);
create index idx_properties_tenant_estado on properties (tenant_id, estado);

create table property_images (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  property_id uuid not null references properties(id) on delete cascade,
  r2_key      text not null unique,
  url         text not null,
  es_portada  boolean not null default false,
  orden       int not null default 0,
  created_at  timestamptz not null default now()
);

create index idx_property_images_property on property_images (property_id, orden);

-- ── updated_at automático ────────────────────────────────────────────────────
create function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger trg_properties_updated_at
  before update on properties
  for each row execute function set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table properties enable row level security;
alter table property_images enable row level security;

-- Lectura: miembros ven todo su tenant; 'public' (sitio/export) también ve las
-- propiedades del tenant — sin aprobación previa. Los campos internos (notas,
-- user_id) se excluyen en los selects de los endpoints públicos, no acá.
create policy prop_select on properties for select using (
  is_super_admin()
  or (tenant_id = ctx_tenant_id() and ctx_rol() in ('admin', 'agente', 'public'))
);

create policy prop_insert on properties for insert with check (
  tenant_id = ctx_tenant_id()
  and user_id = ctx_user_id()
  and ctx_rol() in ('admin', 'agente')
);

create policy prop_update on properties for update using (
  tenant_id = ctx_tenant_id()
  and (ctx_rol() = 'admin' or (ctx_rol() = 'agente' and user_id = ctx_user_id()))
) with check (tenant_id = ctx_tenant_id());

create policy prop_delete on properties for delete using (
  tenant_id = ctx_tenant_id()
  and (ctx_rol() = 'admin' or (ctx_rol() = 'agente' and user_id = ctx_user_id()))
);

-- property_images: lectura sigue a la propiedad; escritura admin o agente dueño
create policy pi_select on property_images for select using (
  is_super_admin()
  or exists (
    select 1 from properties p
    where p.id = property_id
      and p.tenant_id = ctx_tenant_id()
      and ctx_rol() in ('admin', 'agente', 'public')
  )
);

create policy pi_write on property_images for all using (
  tenant_id = ctx_tenant_id()
  and exists (
    select 1 from properties p
    where p.id = property_id
      and p.tenant_id = ctx_tenant_id()
      and (ctx_rol() = 'admin' or (ctx_rol() = 'agente' and p.user_id = ctx_user_id()))
  )
) with check (
  tenant_id = ctx_tenant_id()
  and exists (
    select 1 from properties p
    where p.id = property_id
      and p.tenant_id = ctx_tenant_id()
      and (ctx_rol() = 'admin' or (ctx_rol() = 'agente' and p.user_id = ctx_user_id()))
  )
);
