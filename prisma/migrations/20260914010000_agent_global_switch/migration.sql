-- Interruptor global de Sofi por tenant. No cambia el estado individual de
-- cada conversación: al reactivar, los chats que seguían en bot pueden volver
-- a atenderse con el próximo mensaje entrante.

alter table tenants
  add column agente_activo boolean not null default true;
