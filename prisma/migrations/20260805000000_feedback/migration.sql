-- 0014 feedback — sugerencias y reportes de error de los usuarios del panel.
-- Ver Documents/Claude/Projects/Inmobiliaria lamelas/nuevos-modulos-feedback-y-errores.md
--
-- Un solo módulo con discriminador `tipo` (sugerencia | error): comparten autor,
-- estado, cuerpo y la misma matriz de permisos. Solo los reportes de error
-- aceptan adjuntos (imágenes en R2). Triaje: super_admin (Koi) + admin del
-- tenant; el autor (agente) ve solo lo propio.

-- ── Enums ────────────────────────────────────────────────────────────────────
create type feedback_tipo   as enum ('sugerencia', 'error');
create type feedback_estado as enum ('nuevo', 'en_revision', 'planificada', 'resuelta', 'descartada');

-- ── Ítems ────────────────────────────────────────────────────────────────────
create table feedback_items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  autor_id     uuid not null references users(id),
  tipo         feedback_tipo not null,
  titulo       text not null,
  descripcion  text not null,
  estado       feedback_estado not null default 'nuevo',
  url_contexto text,                       -- ruta del panel donde pasó (reportes)
  user_agent   text,                       -- navegador/SO, autocompletado
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index idx_feedback_tenant_tipo_estado on feedback_items (tenant_id, tipo, estado);
create index idx_feedback_tenant_created on feedback_items (tenant_id, created_at desc);
create index idx_feedback_autor on feedback_items (autor_id);

create trigger trg_feedback_updated_at
  before update on feedback_items
  for each row execute function set_updated_at();

-- ── Adjuntos (solo tipo='error') ─────────────────────────────────────────────
-- Calcado de property_images: R2 por presigned PUT, misma key convention.
create table feedback_adjuntos (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  feedback_id uuid not null references feedback_items(id) on delete cascade,
  r2_key      text not null unique,
  url         text not null,
  orden       int not null default 0,
  created_at  timestamptz not null default now()
);

create index idx_feedback_adjuntos on feedback_adjuntos (feedback_id, orden);

-- ── Comentarios internos (hilo de triaje) ────────────────────────────────────
create table feedback_comentarios (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  feedback_id uuid not null references feedback_items(id) on delete cascade,
  autor_id    uuid not null references users(id),
  cuerpo      text not null,
  created_at  timestamptz not null default now()
);

create index idx_feedback_comentarios on feedback_comentarios (feedback_id, created_at);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table feedback_items enable row level security;
alter table feedback_adjuntos enable row level security;
alter table feedback_comentarios enable row level security;

-- items: super_admin ve todo; admin ve su tenant; el agente solo lo propio.
create policy feedback_select on feedback_items for select using (
  is_super_admin()
  or (tenant_id = ctx_tenant_id() and ctx_rol() = 'admin')
  or (tenant_id = ctx_tenant_id() and ctx_rol() = 'agente' and autor_id = ctx_user_id())
);

-- alta: admin o agente, dentro de su tenant y como autor. El super_admin no
-- tiene tenant → no crea feedback (solo triagea).
create policy feedback_insert on feedback_items for insert with check (
  tenant_id = ctx_tenant_id()
  and autor_id = ctx_user_id()
  and ctx_rol() in ('admin', 'agente')
);

-- cambiar estado: super_admin o admin del tenant.
create policy feedback_update on feedback_items for update using (
  is_super_admin()
  or (tenant_id = ctx_tenant_id() and ctx_rol() = 'admin')
) with check (
  is_super_admin() or tenant_id = ctx_tenant_id()
);

create policy feedback_delete on feedback_items for delete using (
  is_super_admin()
  or (tenant_id = ctx_tenant_id() and ctx_rol() = 'admin')
);

-- adjuntos: heredan la visibilidad del ítem (la subquery pasa por feedback_select).
create policy feedback_adjuntos_select on feedback_adjuntos for select using (
  is_super_admin()
  or exists (select 1 from feedback_items f where f.id = feedback_id)
);

-- alta de adjunto: el autor del reporte (o admin/super_admin). El tenant_id del
-- adjunto tiene que coincidir con el del ítem, que además debe ser visible.
create policy feedback_adjuntos_insert on feedback_adjuntos for insert with check (
  exists (
    select 1 from feedback_items f
    where f.id = feedback_id
      and f.tenant_id = feedback_adjuntos.tenant_id
      and (f.autor_id = ctx_user_id() or ctx_rol() = 'admin' or is_super_admin())
  )
);

create policy feedback_adjuntos_delete on feedback_adjuntos for delete using (
  is_super_admin()
  or exists (
    select 1 from feedback_items f
    where f.id = feedback_id
      and (f.autor_id = ctx_user_id() or (f.tenant_id = ctx_tenant_id() and ctx_rol() = 'admin'))
  )
);

-- comentarios: los ve quien ve el ítem; los crea quien lo ve, como autor, con el
-- tenant del ítem (así el super_admin sin tenant también puede comentar).
create policy feedback_comentarios_select on feedback_comentarios for select using (
  is_super_admin()
  or exists (select 1 from feedback_items f where f.id = feedback_id)
);

create policy feedback_comentarios_insert on feedback_comentarios for insert with check (
  autor_id = ctx_user_id()
  and exists (
    select 1 from feedback_items f
    where f.id = feedback_id and f.tenant_id = feedback_comentarios.tenant_id
  )
);

-- ── Grants ───────────────────────────────────────────────────────────────────
grant select, insert, update, delete
  on feedback_items, feedback_adjuntos, feedback_comentarios
  to app_rt;
grant usage, select on all sequences in schema public to app_rt;
