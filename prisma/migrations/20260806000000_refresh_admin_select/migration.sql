-- 0015 refresh_admin_select — completa la revocación administrada de sesiones
-- (0013 / refresh_admin_revoke).
--
-- Bug: al cambiar la contraseña de un usuario desde el panel, su sesión seguía
-- viva. La 0013 le dio al admin permiso de UPDATE sobre los refresh_tokens de
-- otro usuario, pero en Postgres un `UPDATE ... WHERE` necesita PODER VER las
-- filas: aplica las policies de SELECT para localizar qué actualizar. Como no
-- había una policy de SELECT para el admin sobre tokens ajenos, el WHERE no
-- matcheaba ninguna fila y `updateMany` revocaba 0 tokens (sin error).
--
-- Fix: una policy de SELECT que espeja el USING de refresh_admin_revoke. No se
-- expone ningún secreto: refresh_tokens guarda el HASH del token, no el token.

create policy refresh_admin_select on refresh_tokens for select using (
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
