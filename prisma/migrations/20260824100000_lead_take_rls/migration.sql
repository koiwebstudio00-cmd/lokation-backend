-- Los vendedores necesitan ver consultas libres para poder tomarlas. La policy
-- de UPDATE permite partir de assigned_to null, pero exige que la fila termine
-- asignada al usuario actual. Así PATCH /leads/:id no puede editar una consulta
-- libre sin apropiársela mediante la operación atómica de toma.

drop policy leads_select on leads;
create policy leads_select on leads for select using (
  is_super_admin()
  or (tenant_id = ctx_tenant_id() and ctx_rol() = 'admin')
  or (tenant_id = ctx_tenant_id() and is_auth_ctx())
  or (tenant_id = ctx_tenant_id() and is_agent_ctx())
  or (
    tenant_id = ctx_tenant_id() and ctx_rol() = 'agente'
    and (
      assigned_to is null
      or assigned_to = ctx_user_id()
      or exists (select 1 from properties p where p.id = property_id and p.user_id = ctx_user_id())
    )
  )
);

drop policy leads_update on leads;
create policy leads_update on leads for update using (
  tenant_id = ctx_tenant_id()
  and (
    ctx_rol() = 'admin'
    or is_agent_ctx()
    or (ctx_rol() = 'agente' and (assigned_to is null or assigned_to = ctx_user_id()))
  )
) with check (
  tenant_id = ctx_tenant_id()
  and (
    ctx_rol() = 'admin'
    or is_agent_ctx()
    or (ctx_rol() = 'agente' and assigned_to = ctx_user_id())
  )
);

-- Al tomar un lead libre, primero queda asignado al vendedor y luego su
-- conversación activa pasa a humano. La policy permite esa transición solo si
-- el lead ya quedó asignado al usuario y exige que vendedor_id termine siendo él.
drop policy conversations_update on conversations;
create policy conversations_update on conversations for update using (
  is_super_admin()
  or (tenant_id = ctx_tenant_id() and is_agent_ctx())
  or (tenant_id = ctx_tenant_id() and ctx_rol() = 'admin')
  or (
    tenant_id = ctx_tenant_id() and ctx_rol() = 'agente'
    and (
      vendedor_id = ctx_user_id()
      or exists (select 1 from leads l where l.id = lead_id and l.assigned_to = ctx_user_id())
    )
  )
) with check (
  is_super_admin()
  or (
    tenant_id = ctx_tenant_id()
    and (
      is_agent_ctx()
      or ctx_rol() = 'admin'
      or (ctx_rol() = 'agente' and vendedor_id = ctx_user_id())
    )
  )
);
