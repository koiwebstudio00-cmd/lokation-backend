-- Ubikka inicia sin motor de agente propio. Evita activar el flujo heredado
-- al crear tenants o al importar datos del prototipo.
alter table tenants alter column agente_activo set default false;
update tenants set agente_activo = false where agente_activo = true;
