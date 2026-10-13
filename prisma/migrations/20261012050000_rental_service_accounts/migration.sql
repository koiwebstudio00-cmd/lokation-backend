CREATE TYPE rental_service_type AS ENUM ('luz', 'gas', 'agua', 'internet', 'otro');
CREATE TYPE rental_service_visibility AS ENUM ('interna', 'inquilino', 'propietario', 'ambos');

CREATE TABLE rental_service_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  created_by_id uuid NOT NULL REFERENCES users(id),
  type rental_service_type NOT NULL,
  provider text NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 120),
  account_number text CHECK (account_number IS NULL OR length(account_number) <= 100),
  meter_number text CHECK (meter_number IS NULL OR length(meter_number) <= 100),
  holder_name text CHECK (holder_name IS NULL OR length(holder_name) <= 200),
  visibility rental_service_visibility NOT NULL DEFAULT 'interna',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  CONSTRAINT rental_service_accounts_property_tenant_fkey FOREIGN KEY (property_id, tenant_id)
    REFERENCES properties(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT rental_service_accounts_number_check CHECK (account_number IS NOT NULL OR meter_number IS NOT NULL),
  CONSTRAINT rental_service_accounts_active_check CHECK (
    (active AND deactivated_at IS NULL) OR (NOT active AND deactivated_at IS NOT NULL)
  )
);

CREATE INDEX rental_service_accounts_tenant_property_active_idx
  ON rental_service_accounts (tenant_id, property_id, active);
CREATE INDEX rental_service_accounts_created_by_idx ON rental_service_accounts (created_by_id);

ALTER TABLE rental_service_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_service_accounts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON rental_service_accounts FROM app_rt;
GRANT SELECT, INSERT ON rental_service_accounts TO app_rt;
GRANT UPDATE (active, deactivated_at) ON rental_service_accounts TO app_rt;

CREATE POLICY rental_service_accounts_select ON rental_service_accounts FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);
CREATE POLICY rental_service_accounts_insert ON rental_service_accounts FOR INSERT WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id())
  AND created_by_id = (SELECT ctx_user_id())
  AND (SELECT ctx_rol()) = 'admin'
);
CREATE POLICY rental_service_accounts_update ON rental_service_accounts FOR UPDATE USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
) WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);
