-- 0002 auth — invitations, refresh_tokens, password_resets + RLS.
-- Introduce el contexto interno app.rol = 'auth': lo usa SOLO el módulo auth
-- (login, reset, aceptar invitación) para queries que no tienen usuario todavía.
-- Nunca se deriva de input del request.

-- ── Tablas ───────────────────────────────────────────────────────────────────
create table invitations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  invited_by  uuid not null references users(id),
  email       citext not null,
  rol         user_rol not null check (rol <> 'super_admin'),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);
create index idx_invitations_tenant on invitations (tenant_id);

create table refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index idx_refresh_tokens_user on refresh_tokens (user_id);

create table password_resets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index idx_password_resets_user on password_resets (user_id);

-- ── Helper de contexto interno ───────────────────────────────────────────────
create function is_auth_ctx() returns boolean language sql stable as
  $$ select ctx_rol() = 'auth' $$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table invitations enable row level security;
alter table refresh_tokens enable row level security;
alter table password_resets enable row level security;

-- invitations: super_admin, admin del tenant, o módulo auth (aceptar por token)
create policy invitations_select on invitations for select using (
  is_super_admin() or is_auth_ctx()
  or (ctx_rol() = 'admin' and tenant_id = ctx_tenant_id())
);
create policy invitations_insert on invitations for insert with check (
  is_super_admin()
  or (ctx_rol() = 'admin' and tenant_id = ctx_tenant_id() and rol <> 'super_admin')
);
create policy invitations_update on invitations for update using (
  is_super_admin() or is_auth_ctx()
  or (ctx_rol() = 'admin' and tenant_id = ctx_tenant_id())
);
create policy invitations_delete on invitations for delete using (
  is_super_admin() or (ctx_rol() = 'admin' and tenant_id = ctx_tenant_id())
);

-- refresh_tokens: módulo auth; el usuario puede ver/revocar sus sesiones
create policy refresh_auth_all on refresh_tokens for all
  using (is_auth_ctx()) with check (is_auth_ctx());
create policy refresh_own_select on refresh_tokens for select using (user_id = ctx_user_id());
create policy refresh_own_update on refresh_tokens for update
  using (user_id = ctx_user_id()) with check (user_id = ctx_user_id());

-- password_resets: solo módulo auth
create policy resets_auth_all on password_resets for all
  using (is_auth_ctx()) with check (is_auth_ctx());

-- users/tenants: acceso del módulo auth (login busca por email, invitación crea
-- el usuario, reset actualiza password_hash). Nunca crea super_admins.
create policy users_auth_select on users for select using (is_auth_ctx());
create policy users_auth_insert on users for insert with check (
  is_auth_ctx() and rol <> 'super_admin'
);
create policy users_auth_update on users for update
  using (is_auth_ctx()) with check (is_auth_ctx());

create policy tenants_auth_select on tenants for select using (is_auth_ctx());
