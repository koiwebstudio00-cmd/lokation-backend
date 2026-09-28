-- Agent property links must use the tenant's public site configuration.
-- This context has no user membership, so tenants_select does not cover it.
create policy tenants_agent_select on tenants for select using (
  is_agent_ctx() and id = ctx_tenant_id()
);
