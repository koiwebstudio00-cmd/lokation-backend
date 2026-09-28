-- 0003 fix RLS — bug detectado por tests: el contexto 'public' (tenant fijado
-- por slug/API key) podía leer users y tenants del tenant. Las policies de
-- membresía deben exigir rol miembro, no solo coincidencia de tenant.

-- users: solo miembros del tenant (admin/agente) o super_admin.
-- El acceso del módulo auth sigue cubierto por users_auth_select (0002).
drop policy users_select on users;
create policy users_select on users for select using (
  is_super_admin()
  or (
    ctx_rol() in ('admin', 'agente')
    and tenant_id is not null
    and tenant_id = ctx_tenant_id()
  )
);

-- tenants: idem. Cuando exista el módulo export/sitio público, se agregará
-- una policy explícita para 'public' con lo mínimo necesario.
drop policy tenants_select on tenants;
create policy tenants_select on tenants for select using (
  is_super_admin()
  or (ctx_rol() in ('admin', 'agente') and id = ctx_tenant_id())
);
