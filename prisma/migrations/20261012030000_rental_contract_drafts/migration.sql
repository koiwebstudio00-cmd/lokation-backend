CREATE TYPE rental_contract_status AS ENUM ('borrador', 'vigente', 'finalizado');

ALTER TABLE properties ADD CONSTRAINT properties_id_tenant_id_key UNIQUE (id, tenant_id);
ALTER TABLE rental_people ADD CONSTRAINT rental_people_id_tenant_id_key UNIQUE (id, tenant_id);

CREATE TABLE rental_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  owner_person_id uuid NOT NULL,
  tenant_person_id uuid NOT NULL,
  created_by_id uuid NOT NULL REFERENCES users(id),
  start_date date NOT NULL,
  end_date date NOT NULL,
  monthly_rent numeric(14,2) NOT NULL,
  currency moneda_enum NOT NULL DEFAULT 'ARS',
  due_day smallint NOT NULL,
  status rental_contract_status NOT NULL DEFAULT 'borrador',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rental_contracts_property_tenant_fkey FOREIGN KEY (property_id, tenant_id)
    REFERENCES properties(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT rental_contracts_owner_tenant_fkey FOREIGN KEY (owner_person_id, tenant_id)
    REFERENCES rental_people(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT rental_contracts_tenant_person_tenant_fkey FOREIGN KEY (tenant_person_id, tenant_id)
    REFERENCES rental_people(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT rental_contracts_dates_check CHECK (end_date > start_date),
  CONSTRAINT rental_contracts_rent_check CHECK (monthly_rent > 0),
  CONSTRAINT rental_contracts_due_day_check CHECK (due_day BETWEEN 1 AND 28),
  CONSTRAINT rental_contracts_distinct_people_check CHECK (owner_person_id <> tenant_person_id)
);

CREATE INDEX rental_contracts_tenant_id_created_at_idx ON rental_contracts (tenant_id, created_at DESC);
CREATE INDEX rental_contracts_property_id_tenant_id_idx ON rental_contracts (property_id, tenant_id);
CREATE INDEX rental_contracts_owner_person_id_tenant_id_idx ON rental_contracts (owner_person_id, tenant_id);
CREATE INDEX rental_contracts_tenant_person_id_tenant_id_idx ON rental_contracts (tenant_person_id, tenant_id);
CREATE UNIQUE INDEX rental_contracts_one_active_property_idx ON rental_contracts (property_id) WHERE status = 'vigente';

ALTER TABLE rental_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_contracts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON rental_contracts FROM app_rt;
GRANT SELECT, INSERT ON rental_contracts TO app_rt;

CREATE POLICY rental_contracts_select ON rental_contracts FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);

CREATE POLICY rental_contracts_insert ON rental_contracts FOR INSERT WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id())
  AND created_by_id = (SELECT ctx_user_id())
  AND (SELECT ctx_rol()) = 'admin'
  AND status = 'borrador'
);
