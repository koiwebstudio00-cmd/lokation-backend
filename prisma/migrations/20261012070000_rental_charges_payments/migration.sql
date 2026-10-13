CREATE TABLE rental_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  created_by_id uuid NOT NULL REFERENCES users(id),
  period date NOT NULL CHECK (EXTRACT(DAY FROM period) = 1),
  due_date date NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency moneda_enum NOT NULL,
  concept text NOT NULL DEFAULT 'alquiler' CHECK (length(trim(concept)) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rental_charges_contract_tenant_fkey FOREIGN KEY (contract_id, tenant_id)
    REFERENCES rental_contracts(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (id, tenant_id),
  UNIQUE (contract_id, period, concept)
);
CREATE INDEX rental_charges_tenant_due_idx ON rental_charges (tenant_id, due_date);

CREATE TABLE rental_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  charge_id uuid NOT NULL,
  created_by_id uuid NOT NULL REFERENCES users(id),
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  paid_at date NOT NULL,
  method text NOT NULL CHECK (length(trim(method)) BETWEEN 1 AND 80),
  reference text CHECK (reference IS NULL OR length(reference) <= 160),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  void_reason text,
  voided_by_id uuid REFERENCES users(id),
  CONSTRAINT rental_payments_charge_tenant_fkey FOREIGN KEY (charge_id, tenant_id)
    REFERENCES rental_charges(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT rental_payments_void_check CHECK (
    (voided_at IS NULL AND void_reason IS NULL AND voided_by_id IS NULL) OR
    (voided_at IS NOT NULL AND length(trim(void_reason)) BETWEEN 5 AND 1000 AND voided_by_id IS NOT NULL)
  ),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX rental_payments_tenant_paid_idx ON rental_payments (tenant_id, paid_at);
CREATE INDEX rental_payments_charge_void_idx ON rental_payments (charge_id, voided_at);

ALTER TABLE rental_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_charges FORCE ROW LEVEL SECURITY;
ALTER TABLE rental_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_payments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON rental_charges, rental_payments FROM app_rt;
GRANT SELECT, INSERT ON rental_charges, rental_payments TO app_rt;
GRANT UPDATE (voided_at, void_reason, voided_by_id) ON rental_payments TO app_rt;

CREATE POLICY rental_charges_select ON rental_charges FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);
CREATE POLICY rental_charges_insert ON rental_charges FOR INSERT WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id()) AND created_by_id = (SELECT ctx_user_id())
  AND (SELECT ctx_rol()) = 'admin'
);
CREATE POLICY rental_payments_select ON rental_payments FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);
CREATE POLICY rental_payments_insert ON rental_payments FOR INSERT WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id()) AND created_by_id = (SELECT ctx_user_id())
  AND (SELECT ctx_rol()) = 'admin' AND voided_at IS NULL AND void_reason IS NULL AND voided_by_id IS NULL
);
CREATE POLICY rental_payments_update ON rental_payments FOR UPDATE USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin' AND voided_at IS NULL
) WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
  AND voided_by_id = (SELECT ctx_user_id()) AND voided_at IS NOT NULL
);
