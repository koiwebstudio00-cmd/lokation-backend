-- Identidad completa de conversaciones Zernio y toma desde WhatsApp Business.
-- Permite que el worker registre una intervención humana sin atribuirla a un
-- usuario del panel y sin despertar al agente de IA.

create type lead_tomado_origen as enum ('panel', 'whatsapp_business_app', 'sistema');

alter table leads
  add column tomado_origen lead_tomado_origen;

alter table conversations
  add column channel_account_id uuid references channel_accounts(id) on delete set null,
  add column provider_conversation_id text;

alter table conversation_messages
  add column provider_message_id text;

-- Las conversaciones Zernio se identifican por cuenta + conversación del
-- proveedor. Las entradas web y WhatsApp legado siguen usando canal_ref.
drop index conversations_activa_uq;

create unique index conversations_provider_activa_uq
  on conversations (channel_account_id, provider_conversation_id)
  where estado <> 'cerrada'
    and channel_account_id is not null
    and provider_conversation_id is not null;

create unique index conversations_legacy_activa_uq
  on conversations (tenant_id, canal, canal_ref)
  where estado <> 'cerrada'
    and channel_account_id is null
    and provider_conversation_id is null;

create index idx_conversations_channel_account
  on conversations (channel_account_id);

-- Un reintento del worker no puede duplicar el mensaje humano.
create unique index conversation_messages_provider_uq
  on conversation_messages (conversation_id, provider_message_id)
  where provider_message_id is not null;

-- El agente valida que la cuenta recibida en el envelope pertenece a su
-- tenant. El worker necesita operar únicamente las transiciones producidas
-- por eventos ya autenticados con HMAC.
create policy channel_accounts_agent_select on channel_accounts for select using (
  ctx_rol() = 'agent'
  and tenant_id = ctx_tenant_id()
  and estado = 'activa'
);

create policy conversations_worker_select on conversations for select using (
  ctx_rol() = 'worker'
);

create policy conversations_worker_update on conversations for update using (
  ctx_rol() = 'worker'
) with check (
  ctx_rol() = 'worker'
);

create policy conv_messages_worker_insert on conversation_messages for insert with check (
  ctx_rol() = 'worker'
  and exists (
    select 1 from conversations c
    where c.id = conversation_id and c.tenant_id = tenant_id
  )
);

create policy leads_worker_select on leads for select using (
  ctx_rol() = 'worker'
);

create policy leads_worker_update on leads for update using (
  ctx_rol() = 'worker'
) with check (
  ctx_rol() = 'worker'
);

create policy handoffs_worker_select on handoffs for select using (
  ctx_rol() = 'worker'
);

create policy handoffs_worker_update on handoffs for update using (
  ctx_rol() = 'worker'
) with check (
  ctx_rol() = 'worker'
);
