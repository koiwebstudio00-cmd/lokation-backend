-- El operador de plataforma debe poder invalidar todas las sesiones de una
-- inmobiliaria al suspenderla, sin acceder a sus conversaciones ni leads.
create policy refresh_super_admin_select on refresh_tokens for select
  using (is_super_admin());
create policy refresh_super_admin_revoke on refresh_tokens for update
  using (is_super_admin()) with check (is_super_admin());
