-- Claim con lease para que dos réplicas no despachen la misma entrega a la vez.
-- El id de entrega sigue siendo la clave de idempotencia del receptor.
alter table webhook_deliveries
  add column claim_id uuid,
  add column claimed_at timestamptz;

create index webhook_deliveries_claim_idx
  on webhook_deliveries (claimed_at)
  where estado = 'pendiente';
