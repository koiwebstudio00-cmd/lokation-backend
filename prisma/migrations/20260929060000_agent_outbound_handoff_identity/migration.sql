alter table outbound_message_attempts
  add column handoff_id uuid references handoffs(id) on delete set null;
