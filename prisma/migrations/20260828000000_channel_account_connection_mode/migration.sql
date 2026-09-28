-- Identidad operativa de la conexion de WhatsApp. Las cuentas existentes se
-- conservan como `unknown`: no se puede inferir de forma segura si fueron
-- conectadas por Cloud API o Coexistence solamente mirando la fila local.
alter table channel_accounts
  add column connection_mode text not null default 'unknown',
  add column disconnected_at timestamptz;

alter table channel_accounts
  add constraint channel_accounts_connection_mode_check
  check (connection_mode in ('unknown', 'coexistence', 'cloud_api'));

-- Para las bajas historicas, updated_at es la mejor referencia disponible.
-- No afecta cuentas activas ni cambia el orden de conexion.
update channel_accounts
set disconnected_at = updated_at
where estado = 'desconectada' and disconnected_at is null;
