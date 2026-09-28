-- Permite que el cambio administrado de contrasena cierre sesiones activas
-- del usuario afectado sin saltear RLS. El admin solo alcanza su tenant; el
-- super_admin puede revocar sesiones de usuarios no super_admin.

create policy refresh_admin_revoke on refresh_tokens for update
using (
  exists (
    select 1
    from users u
    where u.id = refresh_tokens.user_id
      and u.rol <> 'super_admin'
      and (
        is_super_admin()
        or (ctx_rol() = 'admin' and u.tenant_id = ctx_tenant_id())
      )
  )
)
with check (
  exists (
    select 1
    from users u
    where u.id = refresh_tokens.user_id
      and u.rol <> 'super_admin'
      and (
        is_super_admin()
        or (ctx_rol() = 'admin' and u.tenant_id = ctx_tenant_id())
      )
  )
);
