-- 0005 crm + webhooks — leads multicanal, notas de seguimiento y sistema de
-- webhooks salientes con outbox transaccional. Ver docs: api-spec.md §8/§10,
-- webhooks.md, permisos-rls.md.

-- ── Enums ────────────────────────────────────────────────────────────────────
create type lead_canal as enum ('web', 'whatsapp', 'instagram', 'messenger', 'manual');
create type lead_estado as enum ('nueva', 'en_contacto', 'ganada', 'perdida');
create type delivery_estado as enum ('pendiente', 'entregada', 'fallida');

-- ── Tablas ───────────────────────────────────────────────────────────────────
create table leads (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  property_id uuid references properties(id) on delete set null,
  assigned_to uuid references users(id),
  canal       lead_canal not null default 'web',
  canal_ref   text,
  nombre      text not null,
  email       text,
  telefono    text,
  mensaje     text not null,
  estado      lead_estado not null default 'nueva',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_leads_tenant_estado on leads (tenant_id, estado);
create index idx_leads_tenant_canal on leads (tenant_id, canal);
create index idx_leads_assigned on leads (assigned_to);

create trigger trg_leads_updated_at
  before update on leads
  for each row execute function set_updated_at();

create table lead_notes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  lead_id    uuid not null references leads(id) on delete cascade,
  user_id    uuid not null references users(id),
  nota       text not null,
  created_at timestamptz not null default now()
);

create index idx_lead_notes_lead on lead_notes (lead_id);

create table webhook_endpoints (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references tenants(id), -- null = global (plataforma)
  url        text not null,
  eventos    text[] not null,
  secret     text not null,
  activo     boolean not null default true,
  created_at timestamptz not null default now()
);

create index idx_webhook_endpoints_tenant on webhook_endpoints (tenant_id);

create table webhook_deliveries (
  id            uuid primary key default gen_random_uuid(),
  endpoint_id   uuid not null references webhook_endpoints(id) on delete cascade,
  evento        text not null,
  payload       jsonb not null,
  intentos      int not null default 0,
  http_status   int,
  estado        delivery_estado not null default 'pendiente',
  next_retry_at timestamptz,
  created_at    timestamptz not null default now()
);

create index idx_webhook_deliveries_pending
  on webhook_deliveries (estado, next_retry_at)
  where estado = 'pendiente';

-- ── Outbox: emitir evento dentro de la transacción de negocio ────────────────
-- SECURITY DEFINER: el que emite (agente/public) no puede leer webhook_endpoints,
-- pero sí generar deliveries para los endpoints suscriptos de su tenant + globales.
create function emit_event(p_evento text, p_payload jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into webhook_deliveries (endpoint_id, evento, payload)
  select we.id, p_evento, p_payload
  from webhook_endpoints we
  where we.activo
    and p_evento = any (we.eventos)
    and (we.tenant_id is null or we.tenant_id = ctx_tenant_id());
end $$;

revoke all on function emit_event(text, jsonb) from public;
grant execute on function emit_event(text, jsonb) to app_rt;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table leads enable row level security;
alter table lead_notes enable row level security;
alter table webhook_endpoints enable row level security;
alter table webhook_deliveries enable row level security;

-- leads: admin ve todos los del tenant; agente los asignados o de sus propiedades
create policy leads_select on leads for select using (
  is_super_admin()
  or (tenant_id = ctx_tenant_id() and ctx_rol() = 'admin')
  or (
    tenant_id = ctx_tenant_id() and ctx_rol() = 'agente'
    and (
      assigned_to = ctx_user_id()
      or exists (select 1 from properties p where p.id = property_id and p.user_id = ctx_user_id())
    )
  )
);

-- alta: formulario público (contexto public/auth con tenant fijado) o manual
create policy leads_insert on leads for insert with check (
  tenant_id = ctx_tenant_id() and ctx_rol() in ('public', 'auth', 'admin', 'agente')
);

create policy leads_update on leads for update using (
  tenant_id = ctx_tenant_id()
  and (ctx_rol() = 'admin' or (ctx_rol() = 'agente' and assigned_to = ctx_user_id()))
) with check (tenant_id = ctx_tenant_id());

create policy leads_delete on leads for delete using (
  tenant_id = ctx_tenant_id() and ctx_rol() = 'admin'
);

-- lead_notes: quien puede ver el lead (la subquery hereda el RLS de leads)
create policy lead_notes_select on lead_notes for select using (
  is_super_admin() or exists (select 1 from leads l where l.id = lead_id)
);
create policy lead_notes_insert on lead_notes for insert with check (
  tenant_id = ctx_tenant_id()
  and user_id = ctx_user_id()
  and exists (select 1 from leads l where l.id = lead_id)
);
create policy lead_notes_update on lead_notes for update
  using (user_id = ctx_user_id()) with check (user_id = ctx_user_id());
create policy lead_notes_delete on lead_notes for delete using (
  tenant_id = ctx_tenant_id() and ctx_rol() = 'admin'
);

-- webhook_endpoints: admin gestiona los de su tenant; super_admin los globales;
-- el worker interno solo lee
create policy we_admin_all on webhook_endpoints for all using (
  is_super_admin() or (ctx_rol() = 'admin' and tenant_id = ctx_tenant_id())
) with check (
  is_super_admin() or (ctx_rol() = 'admin' and tenant_id = ctx_tenant_id())
);
create policy we_worker_select on webhook_endpoints for select using (ctx_rol() = 'worker');

-- webhook_deliveries: worker interno opera; admin consulta las de sus endpoints
create policy wd_worker_all on webhook_deliveries for all
  using (ctx_rol() = 'worker') with check (ctx_rol() = 'worker');
create policy wd_admin_select on webhook_deliveries for select using (
  is_super_admin()
  or exists (
    select 1 from webhook_endpoints we
    where we.id = endpoint_id and we.tenant_id = ctx_tenant_id() and ctx_rol() = 'admin'
  )
);
-- test/ping manual desde el panel
create policy wd_admin_insert on webhook_deliveries for insert with check (
  is_super_admin()
  or exists (
    select 1 from webhook_endpoints we
    where we.id = endpoint_id and we.tenant_id = ctx_tenant_id() and ctx_rol() = 'admin'
  )
);
