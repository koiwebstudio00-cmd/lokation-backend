ALTER TABLE vault_folders ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by_id uuid,
 ADD COLUMN trash_batch_id uuid, ADD COLUMN purge_started_at timestamptz;
ALTER TABLE rental_documents ADD COLUMN trash_batch_id uuid;
CREATE INDEX vault_folders_trash_idx ON vault_folders(tenant_id,deleted_at);
CREATE INDEX rental_documents_trash_batch_idx ON rental_documents(tenant_id,trash_batch_id);
CREATE INDEX vault_folders_trash_batch_idx ON vault_folders(tenant_id,trash_batch_id);

CREATE OR REPLACE FUNCTION vault_folder_allows(folder uuid, editing boolean DEFAULT false) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE node vault_folders; seen uuid[] := '{}';
BEGIN
 IF ctx_rol() NOT IN ('admin','agente') THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM users WHERE id=ctx_user_id() AND tenant_id=ctx_tenant_id() AND estado='activo') THEN RETURN false; END IF;
 IF folder IS NULL THEN RETURN ctx_rol()='admin'; END IF;
 WHILE folder IS NOT NULL LOOP
  IF folder=ANY(seen) OR cardinality(seen)>=100 THEN RETURN false; END IF;
  seen:=array_append(seen,folder);
  SELECT * INTO node FROM vault_folders WHERE id=folder AND tenant_id=ctx_tenant_id();
  IF NOT FOUND OR node.deleted_at IS NOT NULL THEN RETURN false; END IF;
  IF ctx_rol()<>'admin' AND NOT vault_rule_allows(node.access_mode,node.team_permission,node.grants,editing) THEN RETURN false; END IF;
  folder:=node.parent_id;
 END LOOP;
 RETURN true;
END $$;
CREATE POLICY vault_folder_trash_visibility ON vault_folders AS RESTRICTIVE FOR SELECT
 USING (deleted_at IS NULL OR (SELECT ctx_rol())='admin');
DROP POLICY vault_folder_update ON vault_folders;
CREATE POLICY vault_folder_update ON vault_folders FOR UPDATE
 USING (tenant_id=(SELECT ctx_tenant_id()) AND ((SELECT ctx_rol())='admin' OR vault_folder_allows(id,true)))
 WITH CHECK (tenant_id=(SELECT ctx_tenant_id()) AND ((SELECT ctx_rol())='admin' OR vault_folder_allows(parent_id,true)));

CREATE TABLE vault_activity (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 actor_id uuid, actor_name text NOT NULL, entity_id uuid NOT NULL,
 entity_type text NOT NULL CHECK(entity_type IN ('file','folder')), entity_name text NOT NULL,
 action text NOT NULL CHECK(action IN ('created','uploaded','renamed','moved','access_changed','trashed','restored','purged')),
 details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX vault_activity_tenant_time_idx ON vault_activity(tenant_id,created_at DESC,id DESC);
CREATE INDEX vault_activity_entity_idx ON vault_activity(tenant_id,entity_id,created_at DESC);
ALTER TABLE vault_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_activity FORCE ROW LEVEL SECURITY;
GRANT SELECT ON vault_activity TO app_rt;
CREATE POLICY vault_activity_read ON vault_activity FOR SELECT USING(tenant_id=(SELECT ctx_tenant_id()) AND (SELECT ctx_rol())='admin');
CREATE FUNCTION vault_write_activity(row_data jsonb, entity_type text, action text, details jsonb DEFAULT '{}') RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM tenants WHERE id=(row_data->>'tenant_id')::uuid) THEN RETURN; END IF;
 SELECT nombre INTO actor FROM users WHERE id=ctx_user_id() AND tenant_id=(row_data->>'tenant_id')::uuid;
 INSERT INTO vault_activity(tenant_id,actor_id,actor_name,entity_id,entity_type,entity_name,action,details)
 VALUES((row_data->>'tenant_id')::uuid,ctx_user_id(),coalesce(actor,CASE WHEN ctx_rol()='worker' THEN 'Sistema' ELSE 'Proceso interno' END),
 (row_data->>'id')::uuid,entity_type,coalesce(row_data->>'title',row_data->>'name'),action,details);
END $$;
REVOKE ALL ON FUNCTION vault_write_activity(jsonb,text,text,jsonb) FROM PUBLIC;
CREATE FUNCTION vault_audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE old_data jsonb; new_data jsonb; kind text; parent_key text; old_parent text; new_parent text;
BEGIN
 kind:=CASE WHEN TG_TABLE_NAME='vault_folders' THEN 'folder' ELSE 'file' END;
 parent_key:=CASE WHEN kind='folder' THEN 'parent_id' ELSE 'folder_id' END;
 IF TG_OP='DELETE' THEN
  PERFORM vault_write_activity(to_jsonb(OLD),kind,'purged'); RETURN OLD;
 END IF;
 new_data:=to_jsonb(NEW);
 IF TG_OP='INSERT' THEN
  PERFORM vault_write_activity(new_data,kind,CASE WHEN kind='folder' THEN 'created' ELSE 'uploaded' END); RETURN NEW;
 END IF;
 old_data:=to_jsonb(OLD);
 IF (old_data->>'deleted_at') IS NULL AND (new_data->>'deleted_at') IS NOT NULL THEN
  PERFORM vault_write_activity(new_data,kind,'trashed');
 ELSIF (old_data->>'deleted_at') IS NOT NULL AND (new_data->>'deleted_at') IS NULL THEN
  PERFORM vault_write_activity(new_data,kind,'restored');
 END IF;
 IF coalesce(old_data->>'title',old_data->>'name') IS DISTINCT FROM coalesce(new_data->>'title',new_data->>'name') THEN
  PERFORM vault_write_activity(new_data,kind,'renamed',jsonb_build_object('from',coalesce(old_data->>'title',old_data->>'name'),'to',coalesce(new_data->>'title',new_data->>'name')));
 END IF;
 IF (old_data->>parent_key) IS DISTINCT FROM (new_data->>parent_key) THEN
  SELECT name INTO old_parent FROM vault_folders WHERE id=(old_data->>parent_key)::uuid AND tenant_id=NEW.tenant_id;
  SELECT name INTO new_parent FROM vault_folders WHERE id=(new_data->>parent_key)::uuid AND tenant_id=NEW.tenant_id;
  PERFORM vault_write_activity(new_data,kind,'moved',jsonb_build_object('from',coalesce(old_parent,'Mi unidad'),'to',coalesce(new_parent,'Mi unidad')));
 END IF;
 IF (old_data->'access_mode') IS DISTINCT FROM (new_data->'access_mode') OR (old_data->'team_permission') IS DISTINCT FROM (new_data->'team_permission') OR (old_data->'grants') IS DISTINCT FROM (new_data->'grants') THEN
  PERFORM vault_write_activity(new_data,kind,'access_changed');
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION vault_audit_change() FROM PUBLIC;
CREATE TRIGGER vault_folder_audit AFTER INSERT OR UPDATE OR DELETE ON vault_folders FOR EACH ROW EXECUTE FUNCTION vault_audit_change();
CREATE TRIGGER vault_document_audit AFTER INSERT OR UPDATE OR DELETE ON rental_documents FOR EACH ROW EXECUTE FUNCTION vault_audit_change();

-- The worker and staff operations lock tenant first, then documents, in that order.
CREATE OR REPLACE FUNCTION vault_claim_expired() RETURNS TABLE(id uuid,tenant_id uuid,storage_key text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE candidate record; doc rental_documents;
BEGIN
 IF ctx_rol() IS DISTINCT FROM 'worker' THEN RAISE EXCEPTION 'Worker required' USING ERRCODE='42501'; END IF;
 FOR candidate IN SELECT d.id,d.tenant_id FROM rental_documents d WHERE d.deleted_at<=now()-interval '30 days'
 AND (d.purge_claimed_at IS NULL OR d.purge_claimed_at<now()-interval '5 minutes') ORDER BY d.deleted_at,d.id LIMIT 20 LOOP
  IF NOT pg_try_advisory_xact_lock(hashtext(candidate.tenant_id::text)) THEN CONTINUE; END IF;
  SELECT * INTO doc FROM rental_documents d WHERE d.id=candidate.id AND d.deleted_at<=now()-interval '30 days'
   AND (d.purge_claimed_at IS NULL OR d.purge_claimed_at<now()-interval '5 minutes') FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN CONTINUE; END IF;
  UPDATE vault_folders f SET purge_started_at=coalesce(f.purge_started_at,clock_timestamp())
   WHERE f.tenant_id=doc.tenant_id AND f.trash_batch_id=doc.trash_batch_id AND f.deleted_at IS NOT NULL;
  UPDATE rental_documents d SET purge_claimed_at=clock_timestamp() WHERE d.id=doc.id;
  id:=doc.id;tenant_id:=doc.tenant_id;storage_key:=doc.storage_key;RETURN NEXT;
 END LOOP;
END $$;
CREATE FUNCTION vault_purge_empty_folders() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE candidate record; removed integer:=0; n integer;
BEGIN
 IF ctx_rol() IS DISTINCT FROM 'worker' THEN RAISE EXCEPTION 'Worker required' USING ERRCODE='42501'; END IF;
 FOR candidate IN SELECT f.id,f.tenant_id,f.trash_batch_id FROM vault_folders f WHERE f.deleted_at<=now()-interval '30 days'
  AND NOT EXISTS(SELECT 1 FROM vault_folders c WHERE c.parent_id=f.id)
  AND NOT EXISTS(SELECT 1 FROM rental_documents d WHERE d.folder_id=f.id) LIMIT 100 LOOP
  IF NOT pg_try_advisory_xact_lock(hashtext(candidate.tenant_id::text)) THEN CONTINUE; END IF;
  IF NOT EXISTS(SELECT 1 FROM vault_folders f WHERE f.id=candidate.id AND f.deleted_at<=now()-interval '30 days') THEN CONTINUE; END IF;
  UPDATE vault_folders SET purge_started_at=coalesce(purge_started_at,clock_timestamp()) WHERE tenant_id=candidate.tenant_id AND trash_batch_id=candidate.trash_batch_id AND deleted_at IS NOT NULL;
  DELETE FROM vault_folders f WHERE f.id=candidate.id AND f.deleted_at<=now()-interval '30 days'
   AND NOT EXISTS(SELECT 1 FROM vault_folders c WHERE c.parent_id=f.id)
   AND NOT EXISTS(SELECT 1 FROM rental_documents d WHERE d.folder_id=f.id);
  GET DIAGNOSTICS n=ROW_COUNT;removed:=removed+n;
 END LOOP;
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION vault_purge_empty_folders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault_purge_empty_folders() TO app_rt;
