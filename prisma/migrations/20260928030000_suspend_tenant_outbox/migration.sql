-- El operador cancela entregas pendientes del tenant en la misma transacción
-- en que suspende su cuenta. No concede acceso a payloads de otros tenants.
create policy wd_super_admin_update on webhook_deliveries for update
  using (is_super_admin()) with check (is_super_admin());
