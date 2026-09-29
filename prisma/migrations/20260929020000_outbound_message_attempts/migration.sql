create table outbound_message_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  operation_key text not null,
  content text not null,
  status text not null default 'attempted' check (status in ('attempted', 'sent', 'uncertain')),
  provider_message_id text,
  attempted_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (tenant_id, operation_key)
);

create index outbound_message_attempts_status_idx
  on outbound_message_attempts (status, attempted_at);

alter table outbound_message_attempts enable row level security;

create policy outbound_attempt_worker on outbound_message_attempts for all
  using (ctx_rol() = 'worker')
  with check (ctx_rol() = 'worker'
    and exists (select 1 from conversations c
      where c.id = conversation_id and c.tenant_id = tenant_id));

grant select, insert, update on outbound_message_attempts to app_rt;
