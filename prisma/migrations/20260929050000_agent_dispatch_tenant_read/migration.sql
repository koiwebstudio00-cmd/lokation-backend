-- El despachador usa contexto worker con tenant_id fijado por la API key.
-- Sólo puede consultar el estado del tenant de esa llamada.
create policy tenants_worker_select on tenants for select using (
  ctx_rol() = 'worker' and id = ctx_tenant_id()
);
