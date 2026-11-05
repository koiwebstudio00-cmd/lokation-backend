CREATE TABLE rental_guarantors (
 contract_id uuid NOT NULL, person_id uuid NOT NULL, tenant_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(contract_id, person_id),
 FOREIGN KEY(contract_id, tenant_id) REFERENCES rental_contracts(id, tenant_id),
 FOREIGN KEY(person_id, tenant_id) REFERENCES rental_people(id, tenant_id)
);
CREATE INDEX rental_guarantors_person_id_tenant_id_idx ON rental_guarantors(person_id, tenant_id);
CREATE INDEX rental_guarantors_tenant_id_idx ON rental_guarantors(tenant_id);
ALTER TABLE rental_guarantors ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_guarantors FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON rental_guarantors TO app_rt;
CREATE POLICY guarantor_admin ON rental_guarantors FOR ALL
 USING (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin')
 WITH CHECK (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin');
ALTER TABLE rental_documents ADD COLUMN person_id uuid, ADD COLUMN dossier_kind text;
ALTER TABLE rental_documents ADD CONSTRAINT dossier_person_fk FOREIGN KEY(person_id, tenant_id) REFERENCES rental_people(id, tenant_id);
ALTER TABLE rental_documents ADD CONSTRAINT dossier_private CHECK (
 (person_id IS NULL AND dossier_kind IS NULL) OR
 (person_id IS NOT NULL AND contract_id IS NOT NULL AND visibility = 'interna' AND dossier_kind IS NOT NULL AND dossier_kind IN ('identidad','ingresos','garantia','otro'))
);
CREATE INDEX rental_documents_contract_id_person_id_idx ON rental_documents(contract_id, person_id);
CREATE INDEX rental_documents_person_id_tenant_id_idx ON rental_documents(person_id, tenant_id);
