-- Only nonce/expiry is stored; credentials and document metadata never enter this table.
CREATE TABLE file_upload_uses (id uuid PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE INDEX file_upload_uses_expires_at_idx ON file_upload_uses(expires_at);
ALTER TABLE file_upload_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_upload_uses FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON file_upload_uses TO app_rt;
CREATE POLICY file_upload_uses_internal ON file_upload_uses FOR ALL
 USING ((SELECT ctx_rol()) = 'auth') WITH CHECK ((SELECT ctx_rol()) = 'auth');
