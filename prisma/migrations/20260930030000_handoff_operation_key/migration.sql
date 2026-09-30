alter table handoffs add column operation_key text;
create unique index handoffs_tenant_id_operation_key_key
  on handoffs (tenant_id, operation_key);
