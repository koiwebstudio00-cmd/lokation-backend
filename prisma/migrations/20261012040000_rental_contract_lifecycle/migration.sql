ALTER TABLE rental_contracts ADD COLUMN closed_at timestamptz;
ALTER TABLE rental_contracts ADD CONSTRAINT rental_contracts_id_tenant_id_key UNIQUE (id, tenant_id);
ALTER TABLE rental_contracts ADD CONSTRAINT rental_contracts_closed_state_check CHECK (
  (status = 'finalizado' AND closed_at IS NOT NULL)
  OR (status <> 'finalizado' AND closed_at IS NULL)
);

CREATE TABLE rental_contract_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('edited', 'activated', 'finished')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rental_contract_events_contract_tenant_fkey FOREIGN KEY (contract_id, tenant_id)
    REFERENCES rental_contracts(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX rental_contract_events_tenant_id_created_at_idx
  ON rental_contract_events (tenant_id, created_at DESC);
CREATE INDEX rental_contract_events_contract_id_created_at_idx
  ON rental_contract_events (contract_id, created_at DESC);

ALTER TABLE rental_contracts ENABLE ROW LEVEL SECURITY;
GRANT UPDATE (property_id, owner_person_id, tenant_person_id, start_date, end_date,
  monthly_rent, currency, due_day, status, closed_at, updated_at) ON rental_contracts TO app_rt;
CREATE POLICY rental_contracts_update ON rental_contracts FOR UPDATE USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
) WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);

ALTER TABLE rental_contract_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_contract_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON rental_contract_events FROM app_rt;
GRANT SELECT, INSERT ON rental_contract_events TO app_rt;
CREATE POLICY rental_contract_events_select ON rental_contract_events FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);
CREATE POLICY rental_contract_events_insert ON rental_contract_events FOR INSERT WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id())
  AND actor_id = (SELECT ctx_user_id())
  AND (SELECT ctx_rol()) = 'admin'
);
