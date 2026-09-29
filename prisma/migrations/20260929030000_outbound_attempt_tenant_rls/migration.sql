drop policy outbound_attempt_worker on outbound_message_attempts;

create policy outbound_attempt_worker on outbound_message_attempts for all
  using (ctx_rol() = 'worker')
  with check (ctx_rol() = 'worker'
    and exists (select 1 from conversations c
      where c.id = outbound_message_attempts.conversation_id
        and c.tenant_id = outbound_message_attempts.tenant_id));
