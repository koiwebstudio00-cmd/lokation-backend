CREATE TABLE vault_folders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 parent_id uuid, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
 access_mode text NOT NULL DEFAULT 'admin' CHECK (access_mode IN ('admin','inherit','team','selected')),
 team_permission text NOT NULL DEFAULT 'read' CHECK (team_permission IN ('read','edit')),
 grants jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(grants) = 'array'),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,tenant_id),
 FOREIGN KEY(parent_id,tenant_id) REFERENCES vault_folders(id,tenant_id),
 CHECK (parent_id IS DISTINCT FROM id), CHECK (parent_id IS NOT NULL OR access_mode <> 'inherit')
);
CREATE INDEX vault_folders_tenant_parent_idx ON vault_folders(tenant_id,parent_id);
ALTER TABLE rental_documents ADD COLUMN folder_id uuid,
 ADD COLUMN access_mode text NOT NULL DEFAULT 'admin' CHECK (access_mode IN ('admin','inherit','team','selected')),
 ADD COLUMN team_permission text NOT NULL DEFAULT 'read' CHECK (team_permission IN ('read','edit')),
 ADD COLUMN grants jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(grants) = 'array'),
 ADD CONSTRAINT document_folder_tenant_fk FOREIGN KEY(folder_id,tenant_id) REFERENCES vault_folders(id,tenant_id),
 ADD CONSTRAINT document_inherit_folder CHECK (folder_id IS NOT NULL OR access_mode <> 'inherit');
CREATE INDEX rental_documents_tenant_folder_idx ON rental_documents(tenant_id,folder_id);

-- Only staff in the current tenant. A child can narrow, never widen its ancestors.
CREATE FUNCTION vault_rule_allows(mode text, team text, members jsonb, editing boolean) RETURNS boolean
 LANGUAGE sql STABLE SET search_path = public AS $$
 SELECT mode = 'inherit' OR (mode = 'team' AND (NOT editing OR team = 'edit')) OR
 (mode = 'selected' AND EXISTS (SELECT 1 FROM jsonb_array_elements(members) m
 WHERE m->>'userId' = ctx_user_id()::text AND (NOT editing OR m->>'permission' = 'edit')))
$$;
CREATE FUNCTION vault_folder_allows(folder uuid, editing boolean DEFAULT false) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE node vault_folders; seen uuid[] := '{}';
BEGIN
 IF ctx_rol() NOT IN ('admin','agente') THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM users WHERE id=ctx_user_id() AND tenant_id=ctx_tenant_id() AND estado='activo') THEN RETURN false; END IF;
 IF folder IS NULL THEN RETURN ctx_rol()='admin'; END IF;
 WHILE folder IS NOT NULL LOOP
   IF folder = ANY(seen) OR cardinality(seen) >= 100 THEN RETURN false; END IF;
   seen := array_append(seen,folder);
   SELECT * INTO node FROM vault_folders WHERE id=folder AND tenant_id=ctx_tenant_id();
   IF NOT FOUND THEN RETURN false; END IF;
   IF ctx_rol()<>'admin' AND NOT vault_rule_allows(node.access_mode,node.team_permission,node.grants,editing) THEN RETURN false; END IF;
   folder := node.parent_id;
 END LOOP;
 RETURN true;
END $$;
CREATE FUNCTION vault_document_allows(folder uuid, mode text, team text, members jsonb, editing boolean DEFAULT false) RETURNS boolean
 LANGUAGE sql STABLE SET search_path = public AS $$
 SELECT ctx_rol()='admin' OR (ctx_rol()='agente' AND
 (folder IS NULL OR vault_folder_allows(folder,editing)) AND vault_rule_allows(mode,team,members,editing))
$$;
REVOKE ALL ON FUNCTION vault_folder_allows(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault_folder_allows(uuid,boolean) TO app_rt;
ALTER TABLE vault_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_folders FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON vault_folders TO app_rt;
CREATE POLICY vault_folder_read ON vault_folders FOR SELECT USING (tenant_id=(SELECT ctx_tenant_id()) AND vault_folder_allows(id,false));
CREATE POLICY vault_folder_insert ON vault_folders FOR INSERT WITH CHECK (tenant_id=(SELECT ctx_tenant_id()) AND
 ((SELECT ctx_rol())='admin' OR ((SELECT ctx_rol())='agente' AND parent_id IS NOT NULL AND access_mode='inherit' AND vault_folder_allows(parent_id,true))));
CREATE POLICY vault_folder_update ON vault_folders FOR UPDATE USING (tenant_id=(SELECT ctx_tenant_id()) AND vault_folder_allows(id,true)) WITH CHECK (tenant_id=(SELECT ctx_tenant_id()) AND ((SELECT ctx_rol())='admin' OR vault_folder_allows(parent_id,true)));
CREATE POLICY vault_folder_delete ON vault_folders FOR DELETE USING (tenant_id=(SELECT ctx_tenant_id()) AND (SELECT ctx_rol())='admin');
-- Administrators may organize documents uploaded by another team member.
DROP POLICY rental_documents_admin_all ON rental_documents;
CREATE POLICY rental_documents_admin_all ON rental_documents FOR ALL USING (tenant_id=(SELECT ctx_tenant_id()) AND (SELECT ctx_rol())='admin') WITH CHECK (tenant_id=(SELECT ctx_tenant_id()) AND (SELECT ctx_rol())='admin');
CREATE POLICY vault_document_read ON rental_documents FOR SELECT USING (tenant_id=(SELECT ctx_tenant_id()) AND (SELECT ctx_rol())='agente' AND vault_document_allows(folder_id,access_mode,team_permission,grants,false));
CREATE POLICY vault_document_insert ON rental_documents FOR INSERT WITH CHECK (tenant_id=(SELECT ctx_tenant_id()) AND (SELECT ctx_rol())='agente' AND uploaded_by_id=(SELECT ctx_user_id()) AND contract_id IS NULL AND visibility='interna' AND access_mode='inherit' AND vault_folder_allows(folder_id,true));
CREATE POLICY vault_document_update ON rental_documents FOR UPDATE USING (tenant_id=(SELECT ctx_tenant_id()) AND (SELECT ctx_rol())='agente' AND vault_document_allows(folder_id,access_mode,team_permission,grants,true)) WITH CHECK (tenant_id=(SELECT ctx_tenant_id()) AND (SELECT ctx_rol())='agente' AND vault_document_allows(folder_id,access_mode,team_permission,grants,true));
-- Defense in depth: editors cannot change grants, ownership, links or portal visibility.
CREATE FUNCTION vault_editor_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ctx_rol()='agente' AND (to_jsonb(NEW)-'name'-'title'-'parent_id'-'folder_id') IS DISTINCT FROM (to_jsonb(OLD)-'name'-'title'-'parent_id'-'folder_id') THEN
 RAISE EXCEPTION 'Only administrators can change access or document links' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER vault_folder_editor_fields BEFORE UPDATE ON vault_folders FOR EACH ROW EXECUTE FUNCTION vault_editor_fields();
CREATE TRIGGER vault_document_editor_fields BEFORE UPDATE ON rental_documents FOR EACH ROW EXECUTE FUNCTION vault_editor_fields();
