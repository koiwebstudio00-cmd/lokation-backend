-- Evaluate the new row itself, not a snapshot lookup of that row, for INSERT RETURNING.
DROP POLICY vault_folder_read ON vault_folders;
CREATE POLICY vault_folder_read ON vault_folders FOR SELECT USING (
 tenant_id=(SELECT ctx_tenant_id()) AND ((SELECT ctx_rol())='admin' OR
 ((SELECT ctx_rol())='agente' AND vault_rule_allows(access_mode,team_permission,grants,false)
 AND (parent_id IS NULL OR vault_folder_allows(parent_id,false))))
);
GRANT UPDATE ON rental_documents TO app_rt;
CREATE OR REPLACE FUNCTION vault_editor_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ctx_rol()='agente' AND (to_jsonb(NEW)-'name'-'title') IS DISTINCT FROM (to_jsonb(OLD)-'name'-'title') THEN
 RAISE EXCEPTION 'Only administrators can move, change access or document links' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION vault_folder_tree_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE cursor_id uuid; seen uuid[];
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text));
 cursor_id:=NEW.parent_id; seen:=ARRAY[NEW.id];
 WHILE cursor_id IS NOT NULL LOOP
  IF cursor_id=ANY(seen) OR cardinality(seen)>=100 THEN RAISE EXCEPTION 'Folder cycle or depth exceeded' USING ERRCODE='23514'; END IF;
  seen:=array_append(seen,cursor_id);
  SELECT parent_id INTO cursor_id FROM vault_folders WHERE id=cursor_id AND tenant_id=NEW.tenant_id;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER vault_folder_tree_guard BEFORE INSERT OR UPDATE OF parent_id ON vault_folders FOR EACH ROW EXECUTE FUNCTION vault_folder_tree_guard();
