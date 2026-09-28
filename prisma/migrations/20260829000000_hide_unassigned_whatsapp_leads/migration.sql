-- Mientras Sofia atiende un WhatsApp, el lead no tiene vendedor. Los admins
-- conservan la supervision y los contextos internos siguen operando, pero un
-- vendedor recien lo ve cuando el handoff le asigna responsable.

drop policy leads_select on leads;
create policy leads_select on leads for select using (
  is_super_admin()
  or (tenant_id = ctx_tenant_id() and ctx_rol() = 'admin')
  or (tenant_id = ctx_tenant_id() and is_auth_ctx())
  or (tenant_id = ctx_tenant_id() and is_agent_ctx())
  or (
    tenant_id = ctx_tenant_id() and ctx_rol() = 'agente'
    and not (canal = 'whatsapp' and assigned_to is null)
    and (
      assigned_to is null
      or assigned_to = ctx_user_id()
      or exists (select 1 from properties p where p.id = property_id and p.user_id = ctx_user_id())
    )
  )
);

-- Mantiene disponible el pool libre de web/manual, pero impide apropiarse de
-- un WhatsApp que todavia controla Sofia. La asignacion del handoff usa el
-- contexto interno agent y no queda afectada.
drop policy leads_update on leads;
create policy leads_update on leads for update using (
  tenant_id = ctx_tenant_id()
  and (
    ctx_rol() = 'admin'
    or is_agent_ctx()
    or (
      ctx_rol() = 'agente'
      and (
        assigned_to = ctx_user_id()
        or (assigned_to is null and canal <> 'whatsapp')
      )
    )
  )
) with check (
  tenant_id = ctx_tenant_id()
  and (
    ctx_rol() = 'admin'
    or is_agent_ctx()
    or (ctx_rol() = 'agente' and assigned_to = ctx_user_id())
  )
);
