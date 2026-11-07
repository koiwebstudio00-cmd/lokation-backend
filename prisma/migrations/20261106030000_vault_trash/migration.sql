ALTER TABLE rental_documents ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by_id uuid;
CREATE INDEX rental_documents_tenant_deleted_idx ON rental_documents(tenant_id,deleted_at);
-- Restrictive policy intersects every existing staff/portal SELECT policy.
CREATE POLICY vault_trash_visibility ON rental_documents AS RESTRICTIVE FOR SELECT
 USING (deleted_at IS NULL OR (SELECT ctx_rol())='admin');
