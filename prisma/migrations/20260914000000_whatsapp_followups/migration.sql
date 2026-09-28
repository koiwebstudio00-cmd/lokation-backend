-- Seguimiento automático de conversaciones WhatsApp sin respuesta.
-- Los textos viven por tenant; el estado durable vive en la conversación para
-- que múltiples réplicas del worker no dupliquen envíos.

alter table tenants
  add column seguimiento_activo boolean not null default true,
  add column seguimiento_mensaje_1 text not null default 'Hola, ¿seguís interesado/a en la propiedad? Si querés te ayudo con cualquier duda.',
  add column seguimiento_mensaje_2 text not null default 'Te escribo por última vez por tu consulta. Si todavía te interesa, respondeme por acá y seguimos.';

alter table conversations
  add column seguimiento_paso smallint not null default 0,
  add column seguimiento_vencimiento timestamptz,
  add column seguimiento_reclamado_at timestamptz,
  add column ultimo_mensaje_lead_at timestamptz,
  add constraint conversations_seguimiento_paso_check
    check (seguimiento_paso between 0 and 3),
  add constraint conversations_seguimiento_estado_check
    check (
      (seguimiento_paso = 0 and seguimiento_vencimiento is null)
      or (seguimiento_paso between 1 and 3 and seguimiento_vencimiento is not null)
    );

create index idx_conversations_seguimiento_vencimiento
  on conversations (seguimiento_vencimiento)
  where estado = 'bot' and seguimiento_paso between 1 and 3;

alter table handoffs
  add column reasignable boolean not null default true;

create index idx_handoffs_pendientes_reasignables
  on handoffs (tenant_id, asignado_at)
  where resultado = 'pendiente' and reasignable;
