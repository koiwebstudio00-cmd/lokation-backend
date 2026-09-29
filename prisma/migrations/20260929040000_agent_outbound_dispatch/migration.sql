alter table outbound_message_attempts
  drop constraint outbound_message_attempts_status_check;

alter table outbound_message_attempts
  add constraint outbound_message_attempts_status_check
  check (status in ('attempted', 'sent', 'uncertain', 'cancelled'));
