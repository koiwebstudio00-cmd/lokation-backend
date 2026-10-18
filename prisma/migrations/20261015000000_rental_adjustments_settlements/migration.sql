CREATE TABLE rental_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  created_by_id uuid NOT NULL REFERENCES users(id),
  effective_period date NOT NULL CHECK (EXTRACT(DAY FROM effective_period) = 1),
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 5 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rental_adjustments_contract_tenant_fkey FOREIGN KEY (contract_id, tenant_id)
    REFERENCES rental_contracts(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (contract_id, effective_period)
);
CREATE INDEX rental_adjustments_tenant_contract_period_idx ON rental_adjustments
  (tenant_id, contract_id, effective_period DESC);

ALTER TABLE rental_charges ADD CONSTRAINT rental_charges_id_contract_tenant_key
  UNIQUE (id, contract_id, tenant_id);

CREATE TABLE rental_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  charge_id uuid NOT NULL,
  created_by_id uuid NOT NULL REFERENCES users(id),
  gross numeric(14, 2) NOT NULL CHECK (gross > 0),
  commission numeric(14, 2) NOT NULL DEFAULT 0 CHECK (commission >= 0),
  expenses numeric(14, 2) NOT NULL DEFAULT 0 CHECK (expenses >= 0),
  net numeric(14, 2) NOT NULL CHECK (net >= 0),
  currency moneda_enum NOT NULL,
  status text NOT NULL DEFAULT 'preparada' CHECK (status IN ('preparada', 'pagada', 'cancelada')),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at date,
  payment_method text,
  payment_reference text,
  paid_by_id uuid REFERENCES users(id),
  cancelled_at timestamptz,
  cancel_reason text,
  cancelled_by_id uuid REFERENCES users(id),
  CONSTRAINT rental_settlements_contract_tenant_fkey FOREIGN KEY (contract_id, tenant_id)
    REFERENCES rental_contracts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT rental_settlements_charge_contract_tenant_fkey FOREIGN KEY (charge_id, contract_id, tenant_id)
    REFERENCES rental_charges(id, contract_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT rental_settlements_amount_check CHECK (net = gross - commission - expenses),
  CONSTRAINT rental_settlements_state_check CHECK (
    (status = 'preparada' AND paid_at IS NULL AND payment_method IS NULL AND payment_reference IS NULL
      AND paid_by_id IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL AND cancelled_by_id IS NULL)
    OR (status = 'pagada' AND paid_at IS NOT NULL AND payment_method IS NOT NULL
      AND length(trim(payment_method)) BETWEEN 1 AND 80
      AND (payment_reference IS NULL OR length(payment_reference) <= 160)
      AND paid_by_id IS NOT NULL AND cancelled_at IS NULL AND cancel_reason IS NULL AND cancelled_by_id IS NULL)
    OR (status = 'cancelada' AND paid_at IS NULL AND payment_method IS NULL AND payment_reference IS NULL
      AND paid_by_id IS NULL AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL
      AND length(trim(cancel_reason)) BETWEEN 5 AND 1000
      AND cancelled_by_id IS NOT NULL)
  ),
  UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX rental_settlements_one_active_charge_idx ON rental_settlements (charge_id)
  WHERE status <> 'cancelada';
CREATE INDEX rental_settlements_tenant_status_created_idx ON rental_settlements
  (tenant_id, status, created_at DESC);
CREATE INDEX rental_settlements_contract_created_idx ON rental_settlements (contract_id, created_at DESC);
CREATE INDEX rental_settlements_charge_idx ON rental_settlements (charge_id);

ALTER TABLE rental_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_adjustments FORCE ROW LEVEL SECURITY;
ALTER TABLE rental_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_settlements FORCE ROW LEVEL SECURITY;
REVOKE ALL ON rental_adjustments, rental_settlements FROM app_rt;
GRANT SELECT, INSERT ON rental_adjustments, rental_settlements TO app_rt;
GRANT UPDATE (status, paid_at, payment_method, payment_reference, paid_by_id,
  cancelled_at, cancel_reason, cancelled_by_id) ON rental_settlements TO app_rt;

CREATE POLICY rental_adjustments_select ON rental_adjustments FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);
CREATE POLICY rental_adjustments_insert ON rental_adjustments FOR INSERT WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id()) AND created_by_id = (SELECT ctx_user_id())
  AND (SELECT ctx_rol()) = 'admin'
);
CREATE POLICY rental_settlements_select ON rental_settlements FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);
CREATE POLICY rental_settlements_insert ON rental_settlements FOR INSERT WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id()) AND created_by_id = (SELECT ctx_user_id())
  AND (SELECT ctx_rol()) = 'admin' AND status = 'preparada'
);
CREATE POLICY rental_settlements_update ON rental_settlements FOR UPDATE USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin' AND status = 'preparada'
) WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
  AND ((status = 'pagada' AND paid_by_id = (SELECT ctx_user_id()))
    OR (status = 'cancelada' AND cancelled_by_id = (SELECT ctx_user_id())))
);
