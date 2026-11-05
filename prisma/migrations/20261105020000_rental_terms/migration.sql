ALTER TABLE rental_settlements ADD COLUMN commission_details jsonb;
CREATE TABLE rental_terms (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 contract_id uuid NOT NULL, created_by_id uuid NOT NULL REFERENCES users(id),
 effective_period date NOT NULL CHECK (extract(day FROM effective_period) = 1),
 commission_rate decimal(5,2) NOT NULL CHECK (commission_rate BETWEEN 0 AND 100),
 commission_basis text NOT NULL CHECK (commission_basis IN ('alquiler_cobrado','alquiler_periodo')),
 adjustment_method text NOT NULL CHECK (adjustment_method IN ('sin_actualizacion','manual','ICL','IPC','fijo','otro')),
 frequency_months integer CHECK (frequency_months BETWEEN 1 AND 36),
 first_adjustment_period date CHECK (extract(day FROM first_adjustment_period) = 1),
 fixed_percent decimal(7,2) CHECK (fixed_percent BETWEEN 0 AND 9999.99),
 note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(contract_id, tenant_id) REFERENCES rental_contracts(id, tenant_id) ON DELETE RESTRICT,
 CHECK ((adjustment_method = 'sin_actualizacion' AND frequency_months IS NULL AND first_adjustment_period IS NULL AND fixed_percent IS NULL)
 OR (adjustment_method <> 'sin_actualizacion' AND frequency_months IS NOT NULL AND first_adjustment_period IS NOT NULL AND first_adjustment_period >= effective_period
 AND ((adjustment_method = 'fijo' AND fixed_percent IS NOT NULL) OR (adjustment_method <> 'fijo' AND fixed_percent IS NULL))))
);
CREATE INDEX rental_terms_contract_id_effective_period_created_at_idx ON rental_terms(contract_id, effective_period DESC, created_at DESC);
CREATE INDEX rental_terms_tenant_id_contract_id_idx ON rental_terms(tenant_id, contract_id);
ALTER TABLE rental_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_terms FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON rental_terms TO app_rt;
CREATE POLICY rental_terms_read ON rental_terms FOR SELECT USING
 (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin');
CREATE POLICY rental_terms_create ON rental_terms FOR INSERT WITH CHECK
 (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin' AND created_by_id = (SELECT ctx_user_id()));
