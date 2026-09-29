-- Reclamo con lease para procesar cada ráfaga en una sola réplica.
alter table channel_webhook_events
  add column claim_id uuid,
  add column claimed_at timestamptz;

create index channel_webhook_events_claim_idx
  on channel_webhook_events (claimed_at)
  where estado = 'pendiente';
