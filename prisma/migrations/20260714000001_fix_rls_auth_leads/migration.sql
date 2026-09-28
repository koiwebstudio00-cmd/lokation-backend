-- 0006 fix RLS — detectado por tests: el contexto interno 'auth' (alta pública
-- de leads por slug) necesita (a) leer la propiedad consultada para asignar el
-- agente, y (b) leer la fila de leads que inserta (Prisma hace INSERT+lectura).
-- Mismo patrón que users_auth_select en 0002. Siempre acotado al tenant fijado.

drop policy prop_select on properties;
create policy prop_select on properties for select using (
  is_super_admin()
  or (tenant_id = ctx_tenant_id() and ctx_rol() in ('admin', 'agente', 'public'))
  or (tenant_id = ctx_tenant_id() and is_auth_ctx())
);

drop policy leads_select on leads;
create policy leads_select on leads for select using (
  is_super_admin()
  or (tenant_id = ctx_tenant_id() and ctx_rol() = 'admin')
  or (tenant_id = ctx_tenant_id() and is_auth_ctx())
  or (
    tenant_id = ctx_tenant_id() and ctx_rol() = 'agente'
    and (
      assigned_to = ctx_user_id()
      or exists (select 1 from properties p where p.id = property_id and p.user_id = ctx_user_id())
    )
  )
);
