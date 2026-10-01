ALTER TABLE users ADD COLUMN auth_version integer NOT NULL DEFAULT 0, ADD COLUMN deleted_at timestamptz;
CREATE TABLE user_security (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 secret text, pending_secret text, pending_expires_at timestamptz,
 enabled boolean NOT NULL DEFAULT false, last_step integer NOT NULL DEFAULT 0,
 recovery_hashes text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE passkeys (
 id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 public_key bytea NOT NULL, counter bigint NOT NULL DEFAULT 0,
 transports text[] NOT NULL DEFAULT '{}', nombre text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX passkeys_user_idx ON passkeys(user_id);
CREATE TABLE auth_challenges (
 id text PRIMARY KEY, user_id uuid, kind text NOT NULL, challenge text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX auth_challenges_expiry_idx ON auth_challenges(expires_at);
CREATE TABLE platform_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL,
 action text NOT NULL, target_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_target_idx ON platform_audit(target_id, created_at);
ALTER TABLE user_security ENABLE ROW LEVEL SECURITY;
ALTER TABLE passkeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_auth ON user_security FOR ALL USING (is_auth_ctx()) WITH CHECK (is_auth_ctx());
CREATE POLICY passkeys_auth ON passkeys FOR ALL USING (is_auth_ctx()) WITH CHECK (is_auth_ctx());
CREATE POLICY challenges_auth ON auth_challenges FOR ALL USING (is_auth_ctx()) WITH CHECK (is_auth_ctx());
CREATE POLICY audit_read ON platform_audit FOR SELECT USING (is_super_admin());
CREATE POLICY audit_insert ON platform_audit FOR INSERT WITH CHECK (is_super_admin() OR is_auth_ctx());
GRANT SELECT, INSERT, UPDATE, DELETE ON user_security, passkeys, auth_challenges, platform_audit TO app_rt;
