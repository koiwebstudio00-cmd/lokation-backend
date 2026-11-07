-- Community is tenant staff, with no CRM, rental or administration access.
CREATE POLICY community_users_read ON users FOR SELECT USING (ctx_rol()='community' AND tenant_id=ctx_tenant_id());
CREATE POLICY community_tenant_read ON tenants FOR SELECT USING (ctx_rol()='community' AND id=ctx_tenant_id());
CREATE POLICY community_properties_read ON properties FOR SELECT USING (ctx_rol()='community' AND tenant_id=ctx_tenant_id());
CREATE POLICY community_images_read ON property_images FOR SELECT USING (ctx_rol()='community' AND EXISTS(SELECT 1 FROM properties p WHERE p.id=property_id AND p.tenant_id=ctx_tenant_id()));
CREATE POLICY community_task_read ON team_tasks FOR SELECT USING (ctx_rol()='community' AND tenant_id=ctx_tenant_id() AND assigned_to_id=ctx_user_id());
CREATE POLICY community_task_update ON team_tasks FOR UPDATE USING (ctx_rol()='community' AND tenant_id=ctx_tenant_id() AND assigned_to_id=ctx_user_id()) WITH CHECK (ctx_rol()='community' AND tenant_id=ctx_tenant_id() AND assigned_to_id=ctx_user_id());
CREATE OR REPLACE FUNCTION guard_task_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ctx_rol() IN ('agente','community') AND (to_jsonb(NEW)-'status'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'updated_at') THEN
  RAISE EXCEPTION 'Only task status can be changed' USING ERRCODE='42501';
 END IF; RETURN NEW;
END $$;
CREATE POLICY community_feedback_read ON feedback_items FOR SELECT USING (ctx_rol()='community' AND tenant_id=ctx_tenant_id() AND autor_id=ctx_user_id());
CREATE POLICY community_feedback_insert ON feedback_items FOR INSERT WITH CHECK (ctx_rol()='community' AND tenant_id=ctx_tenant_id() AND autor_id=ctx_user_id());
-- Public means shared with this tenant's team, never anonymous/public Internet.
CREATE OR REPLACE FUNCTION vault_folder_allows(folder uuid, editing boolean DEFAULT false) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE node vault_folders; seen uuid[] := '{}';
BEGIN
 IF ctx_rol() NOT IN ('admin','agente','community') THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM users WHERE id=ctx_user_id() AND tenant_id=ctx_tenant_id() AND estado='activo' AND deleted_at IS NULL) THEN RETURN false; END IF;
 IF folder IS NULL THEN RETURN ctx_rol() IN ('admin','community'); END IF;
 IF ctx_rol()='community' AND editing THEN RETURN false; END IF;
 WHILE folder IS NOT NULL LOOP
  IF folder=ANY(seen) OR cardinality(seen)>=100 THEN RETURN false; END IF;
  seen:=array_append(seen,folder);
  SELECT * INTO node FROM vault_folders WHERE id=folder AND tenant_id=ctx_tenant_id();
  IF NOT FOUND OR node.deleted_at IS NOT NULL THEN RETURN false; END IF;
  IF ctx_rol()='community' AND node.access_mode NOT IN ('team','inherit') THEN RETURN false; END IF;
  IF ctx_rol()='agente' AND NOT vault_rule_allows(node.access_mode,node.team_permission,node.grants,editing) THEN RETURN false; END IF;
  folder:=node.parent_id;
 END LOOP; RETURN true;
END $$;
CREATE POLICY community_folder_read ON vault_folders FOR SELECT USING (ctx_rol()='community' AND tenant_id=ctx_tenant_id() AND access_mode IN ('team','inherit') AND (parent_id IS NULL OR vault_folder_allows(parent_id,false)));
CREATE POLICY community_document_read ON rental_documents FOR SELECT USING (ctx_rol()='community' AND tenant_id=ctx_tenant_id() AND (folder_id IS NULL OR vault_folder_allows(folder_id,false)) AND (uploaded_by_id=ctx_user_id() OR access_mode='team' OR (access_mode='inherit' AND folder_id IS NOT NULL)));
CREATE POLICY community_document_insert ON rental_documents FOR INSERT WITH CHECK (ctx_rol()='community' AND tenant_id=ctx_tenant_id() AND uploaded_by_id=ctx_user_id() AND folder_id IS NULL AND contract_id IS NULL AND person_id IS NULL AND dossier_kind IS NULL AND visibility='interna' AND access_mode='admin' AND grants='[]'::jsonb AND deleted_at IS NULL AND purge_claimed_at IS NULL);
CREATE POLICY community_document_update ON rental_documents FOR UPDATE USING (ctx_rol()='community' AND tenant_id=ctx_tenant_id() AND uploaded_by_id=ctx_user_id() AND deleted_at IS NULL AND (folder_id IS NULL OR vault_folder_allows(folder_id,false))) WITH CHECK (ctx_rol()='community' AND tenant_id=ctx_tenant_id() AND uploaded_by_id=ctx_user_id());
CREATE OR REPLACE FUNCTION vault_editor_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ctx_rol() IN ('agente','community') AND (to_jsonb(NEW)-'name'-'title') IS DISTINCT FROM (to_jsonb(OLD)-'name'-'title') THEN
 RAISE EXCEPTION 'Only administrators can move, change access or document links' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
-- Previously received CRM notifications must not remain visible after a role change.
CREATE POLICY community_notifications_hidden ON notifications AS RESTRICTIVE USING (ctx_rol()<>'community');
