-- La asignación indica quién es responsable del lead; la toma registra quién
-- confirmó la primera atención y cuándo. Ambos campos son nullable para que la
-- migración sea aditiva y los leads existentes arranquen como pendientes.

alter table leads
  add column tomado_at timestamptz,
  add column tomado_por uuid references users(id) on delete set null;

-- Soporta el contador personal de consultas asignadas todavía sin tomar:
-- assigned_to = usuario actual and tomado_at is null, siempre dentro del tenant.
create index leads_assigned_pending_idx
  on leads (tenant_id, assigned_to, created_at desc)
  where tomado_at is null;
