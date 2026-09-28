-- 0018 channel_accounts_zernio — conexión de canales de mensajería vía Zernio
-- (WhatsApp por ahora) y cola de eventos entrantes. Ver
-- lamelas-agent/docs/plan-implementacion-zernio.md §3.
--
-- Escrita a mano: `prisma migrate dev --create-only` generó además un diff de
-- drift preexistente (DROP/RECREATE de foreign keys y RENAME de índices no
-- relacionados con este cambio) — se descarta esa parte, regla 4 del
-- CLAUDE.md ("si migrate dev detecta drift y propone crear una migración no
-- pedida: cancelar y revisar"). Este archivo solo contiene lo que corresponde
-- a esta feature.

-- ── Profile de Zernio por tenant (lazy, 1:1) ─────────────────────────────────
alter table tenants add column zernio_profile_id text;

-- ── Cuentas de canal conectadas ──────────────────────────────────────────────
-- 1 tenant + 1 canal = a lo sumo 1 cuenta activa (índice parcial abajo). El
-- `check` de canal se limita a 'whatsapp' a propósito: Instagram todavía no
-- tiene pedido explícito (regla 10 del CLAUDE.md) — se amplía cuando se
-- retome, sin tocar esta migración.
create table channel_accounts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  canal             text not null check (canal in ('whatsapp')),
  zernio_profile_id text not null,
  zernio_account_id text not null,
  -- Snapshot liviano para el panel, sin ir a pedirle a Zernio cada vez.
  display_name      text,               -- verifiedName (Meta)
  display_phone     text,               -- E.164
  estado            text not null default 'activa'
                     check (estado in ('activa', 'desconectada', 'error')),
  conectada_por     uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Clave del join que hace el worker al resolver a qué tenant pertenece un
-- evento entrante (payload.account.id de Zernio).
create unique index channel_accounts_zernio_account_uq
  on channel_accounts (zernio_account_id);

create unique index channel_accounts_tenant_canal_activa_uq
  on channel_accounts (tenant_id, canal)
  where estado = 'activa';

create index idx_channel_accounts_tenant on channel_accounts (tenant_id);

create trigger trg_channel_accounts_updated_at
  before update on channel_accounts
  for each row execute function set_updated_at();

-- ── Cola de eventos entrantes de Zernio ──────────────────────────────────────
-- Sin tenant_id: el handler HTTP del webhook todavía no sabe a qué tenant
-- pertenece (eso lo resuelve el worker via channel_accounts). Ver plan §5.
create table channel_webhook_events (
  id             uuid primary key default gen_random_uuid(),
  -- Dedupe: Zernio entrega at-least-once (payload.id / X-Zernio-Event-Id).
  zernio_event_id text not null unique,
  evento         text not null,          -- message.received, conversation.started, ...
  payload        jsonb not null,
  estado         text not null default 'pendiente'
                 check (estado in ('pendiente', 'procesado', 'error')),
  intentos       int not null default 0,
  error_detalle  text,
  recibido_at    timestamptz not null default now(),
  procesado_at   timestamptz
);

create index idx_channel_webhook_events_pendientes
  on channel_webhook_events (estado, recibido_at)
  where estado = 'pendiente';

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table channel_accounts enable row level security;
alter table channel_webhook_events enable row level security;

-- channel_accounts: el admin gestiona las de su tenant (conectar/desconectar
-- es acción de admin, igual que las API keys); el worker interno solo lee,
-- para resolver accountId → tenant al procesar un evento.
create policy channel_accounts_admin_all on channel_accounts for all using (
  is_super_admin() or (ctx_rol() = 'admin' and tenant_id = ctx_tenant_id())
) with check (
  is_super_admin() or (ctx_rol() = 'admin' and tenant_id = ctx_tenant_id())
);

create policy channel_accounts_worker_select on channel_accounts for select using (
  ctx_rol() = 'worker'
);

-- channel_webhook_events: exclusivamente el contexto interno 'worker' — lo
-- inserta el handler HTTP del webhook (sin tenant conocido todavía) y lo
-- procesa el worker. Ningún otro rol necesita verlo, es una cola interna.
create policy cwe_worker_all on channel_webhook_events for all
  using (ctx_rol() = 'worker') with check (ctx_rol() = 'worker');

-- ── Grants ───────────────────────────────────────────────────────────────────
grant select, insert, update, delete on channel_accounts, channel_webhook_events to app_rt;
