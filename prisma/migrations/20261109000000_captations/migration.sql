CREATE TABLE captations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 created_by_id uuid NOT NULL, assigned_to_id uuid NOT NULL,
 title text NOT NULL, address text NOT NULL, city text NOT NULL, zone text NOT NULL DEFAULT '', type text NOT NULL,
 operation text NOT NULL CHECK(operation IN ('venta','alquiler')),
 status text NOT NULL DEFAULT 'nueva' CHECK(status IN ('nueva','en_revision','lista','archivada')),
 details jsonb NOT NULL DEFAULT '{}', owner_person_id uuid, property_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(created_by_id,tenant_id) REFERENCES users(id,tenant_id),
 FOREIGN KEY(assigned_to_id,tenant_id) REFERENCES users(id,tenant_id),
 FOREIGN KEY(owner_person_id,tenant_id) REFERENCES rental_people(id,tenant_id),
 FOREIGN KEY(property_id,tenant_id) REFERENCES properties(id,tenant_id)
);
CREATE INDEX captations_tenant_id_assigned_to_id_created_at_idx ON captations(tenant_id,assigned_to_id,created_at);
ALTER TABLE captations ENABLE ROW LEVEL SECURITY;
ALTER TABLE captations FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON captations TO app_rt;
CREATE POLICY captation_admin ON captations FOR ALL USING(tenant_id=ctx_tenant_id() AND ctx_rol()='admin') WITH CHECK(tenant_id=ctx_tenant_id() AND ctx_rol()='admin');
CREATE POLICY captation_agent_read ON captations FOR SELECT USING(tenant_id=ctx_tenant_id() AND ctx_rol()='agente' AND assigned_to_id=ctx_user_id());
CREATE POLICY captation_agent_insert ON captations FOR INSERT WITH CHECK(tenant_id=ctx_tenant_id() AND ctx_rol()='agente' AND assigned_to_id=ctx_user_id() AND created_by_id=ctx_user_id() AND owner_person_id IS NULL AND property_id IS NULL);
CREATE POLICY captation_agent_update ON captations FOR UPDATE USING(tenant_id=ctx_tenant_id() AND ctx_rol()='agente' AND assigned_to_id=ctx_user_id()) WITH CHECK(tenant_id=ctx_tenant_id() AND ctx_rol()='agente' AND assigned_to_id=ctx_user_id());
CREATE FUNCTION guard_captation_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id THEN
  RAISE EXCEPTION 'Immutable captation identity' USING ERRCODE='42501';
 END IF;
 IF ctx_rol()='agente' AND (NEW.assigned_to_id IS DISTINCT FROM OLD.assigned_to_id OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id OR NEW.property_id IS DISTINCT FROM OLD.property_id) THEN
  RAISE EXCEPTION 'Only administrators can change assignments and links' USING ERRCODE='42501';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER captation_links_guard BEFORE UPDATE ON captations FOR EACH ROW EXECUTE FUNCTION guard_captation_links();
