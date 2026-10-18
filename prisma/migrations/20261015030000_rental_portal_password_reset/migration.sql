CREATE TABLE rental_portal_password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES rental_portal_accounts(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rental_portal_password_resets_account_expires_idx ON rental_portal_password_resets (account_id, expires_at);
ALTER TABLE rental_portal_password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_portal_password_resets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON rental_portal_password_resets FROM app_rt;
GRANT SELECT, INSERT, UPDATE ON rental_portal_password_resets TO app_rt;
CREATE POLICY rental_portal_password_resets_auth ON rental_portal_password_resets FOR ALL
  USING ((SELECT ctx_rol()) = 'auth') WITH CHECK ((SELECT ctx_rol()) = 'auth');
