-- 0009 restore defaults — reparación del drift de `prisma migrate dev`.
-- La migración auto-generada 20260726055723 borró los DEFAULT gen_random_uuid()
-- de los id (Prisma modela @default(uuid()) como default de cliente, no de BD)
-- y convirtió los email citext → text. Eso rompió emit_event() (inserta por SQL
-- y depende del default de BD) y la case-insensitivity de emails.
-- Se restaura todo; schema.prisma pasa a @default(dbgenerated("gen_random_uuid()"))
-- y @db.Citext para que el diff quede alineado.
-- REGLA NUEVA (CLAUDE.md regla 4): migraciones SIEMPRE con
-- `prisma migrate dev --create-only` + revisión del SQL; aplicar con `migrate deploy`.

alter table tenants            alter column id set default gen_random_uuid();
alter table users              alter column id set default gen_random_uuid();
alter table invitations        alter column id set default gen_random_uuid();
alter table refresh_tokens     alter column id set default gen_random_uuid();
alter table password_resets    alter column id set default gen_random_uuid();
alter table properties         alter column id set default gen_random_uuid();
alter table property_images    alter column id set default gen_random_uuid();
alter table leads              alter column id set default gen_random_uuid();
alter table lead_notes         alter column id set default gen_random_uuid();
alter table webhook_endpoints  alter column id set default gen_random_uuid();
alter table webhook_deliveries alter column id set default gen_random_uuid();
alter table api_keys           alter column id set default gen_random_uuid();

-- Emails case-insensitive de nuevo (login "Juan@x.com" == "juan@x.com")
alter table users       alter column email set data type citext;
alter table invitations alter column email set data type citext;
