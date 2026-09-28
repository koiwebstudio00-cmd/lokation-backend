-- 0007 export — API keys por tenant + contexto interno 'export'.
-- Gestión (panel, admin): crear/listar/revocar keys del tenant.
-- Consumo: el middleware resuelve X-Api-Key → tenant con app.rol = 'export'
-- (lookup cross-tenant por hash único y secreto; nunca derivado de otro input).
-- Los datos se sirven después con el contexto 'public' de 0004, acotado al
-- tenant de la key.

create table api_keys (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  created_by    uuid not null references users(id),
  nombre        text not null,
  key_hash      text not null unique,
  prefix        text not null,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index idx_api_keys_tenant on api_keys (tenant_id);

-- ── Helper de contexto interno ───────────────────────────────────────────────
create function is_export_ctx() returns boolean language sql stable as
  $$ select ctx_rol() = 'export' $$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table api_keys enable row level security;

-- Gestión: admin del tenant (y super_admin). Consumo: el contexto export
-- resuelve la key por hash — sin tenant fijado todavía, por eso sin acotar.
create policy api_keys_select on api_keys for select using (
  is_super_admin()
  or (ctx_rol() = 'admin' and tenant_id = ctx_tenant_id())
  or is_export_ctx()
);

create policy api_keys_insert on api_keys for insert with check (
  is_super_admin() or (ctx_rol() = 'admin' and tenant_id = ctx_tenant_id())
);

-- Update: el admin revoca (revoked_at); el contexto export marca last_used_at.
create policy api_keys_update on api_keys for update using (
  is_super_admin()
  or (ctx_rol() = 'admin' and tenant_id = ctx_tenant_id())
  or is_export_ctx()
) with check (
  is_super_admin()
  or (ctx_rol() = 'admin' and tenant_id = ctx_tenant_id())
  or is_export_ctx()
);

-- Sin delete: la revocación es revoked_at (queda auditable).

-- tenants: el contexto export necesita leer el tenant de la key para validar
-- su estado (suspendido ⇒ la key deja de operar). Lección de 0006: todo
-- contexto nuevo necesita SELECT sobre lo que Prisma lee.
create policy tenants_export_select on tenants for select using (is_export_ctx());
