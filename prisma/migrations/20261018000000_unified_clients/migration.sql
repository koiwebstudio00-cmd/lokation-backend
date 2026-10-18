ALTER TYPE rental_person_role ADD VALUE IF NOT EXISTS 'comprador';
ALTER TYPE rental_person_role ADD VALUE IF NOT EXISTS 'vendedor';
ALTER TABLE leads ADD CONSTRAINT leads_id_tenant_id_key UNIQUE (id, tenant_id);
CREATE TABLE client_operations (
  person_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, lead_id),
  FOREIGN KEY (person_id, tenant_id) REFERENCES rental_people(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id, tenant_id) REFERENCES leads(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX client_operations_tenant_id_lead_id_idx ON client_operations(tenant_id, lead_id);
ALTER TABLE client_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_operations FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON client_operations TO app_rt;
CREATE POLICY client_operations_admin ON client_operations FOR ALL
USING (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin')
WITH CHECK (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin');
