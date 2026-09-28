-- createPublicLead usa el contexto interno auth con tenant_id ya resuelto por
-- slug. Necesita elegir, bloquear y avanzar el turno en la misma transacción
-- que crea el lead.

drop policy vendedores_agente_select on vendedores_agente;
create policy vendedores_agente_select on vendedores_agente for select using (
  is_super_admin()
  or (tenant_id = ctx_tenant_id() and is_agent_ctx())
  or (tenant_id = ctx_tenant_id() and is_auth_ctx())
  or (tenant_id = ctx_tenant_id() and ctx_rol() = 'admin')
  or (tenant_id = ctx_tenant_id() and ctx_rol() = 'agente' and user_id = ctx_user_id())
);

drop policy vendedores_agente_insert on vendedores_agente;
create policy vendedores_agente_insert on vendedores_agente for insert with check (
  tenant_id = ctx_tenant_id()
  and (ctx_rol() = 'admin' or is_agent_ctx() or is_auth_ctx())
);

drop policy vendedores_agente_update on vendedores_agente;
create policy vendedores_agente_update on vendedores_agente for update using (
  tenant_id = ctx_tenant_id()
  and (ctx_rol() = 'admin' or is_agent_ctx() or is_auth_ctx())
) with check (tenant_id = ctx_tenant_id());
