CREATE TABLE property_copy_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model text NOT NULL,
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX property_copy_usage_tenant_id_created_at_idx
  ON property_copy_usage (tenant_id, created_at DESC);

ALTER TABLE property_copy_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_copy_usage FORCE ROW LEVEL SECURITY;
REVOKE ALL ON property_copy_usage FROM app_rt;
GRANT SELECT, INSERT ON property_copy_usage TO app_rt;

CREATE POLICY property_copy_usage_insert ON property_copy_usage FOR INSERT WITH CHECK (
  tenant_id = ctx_tenant_id()
  AND user_id = ctx_user_id()
  AND ctx_rol() IN ('admin', 'agente')
);

CREATE POLICY property_copy_usage_select ON property_copy_usage FOR SELECT USING (
  tenant_id = ctx_tenant_id()
  AND (ctx_rol() = 'admin' OR (ctx_rol() = 'agente' AND user_id = ctx_user_id()))
);
