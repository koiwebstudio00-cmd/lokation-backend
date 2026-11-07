ALTER TABLE rental_documents ADD COLUMN purge_claimed_at timestamptz;
-- A claimed row is never restored while filesystem deletion may be in flight.
CREATE FUNCTION vault_purge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ctx_rol() IS DISTINCT FROM 'worker' AND
   (OLD.purge_claimed_at IS NOT NULL OR NEW.purge_claimed_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Document purge already started' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER vault_purge_guard BEFORE UPDATE ON rental_documents FOR EACH ROW EXECUTE FUNCTION vault_purge_guard();
CREATE FUNCTION vault_claim_expired() RETURNS TABLE(id uuid, tenant_id uuid, storage_key text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF ctx_rol() IS DISTINCT FROM 'worker' THEN RAISE EXCEPTION 'Worker required' USING ERRCODE='42501'; END IF;
 RETURN QUERY
 WITH candidates AS (
  SELECT d.id FROM rental_documents d WHERE d.deleted_at <= now()-interval '30 days'
   AND (d.purge_claimed_at IS NULL OR d.purge_claimed_at < now()-interval '5 minutes')
  ORDER BY d.deleted_at,d.id LIMIT 20 FOR UPDATE SKIP LOCKED
 )
 UPDATE rental_documents d SET purge_claimed_at=clock_timestamp() FROM candidates c WHERE d.id=c.id
 RETURNING d.id,d.tenant_id,d.storage_key;
END $$;
CREATE FUNCTION vault_finish_purge(document_id uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF ctx_rol() IS DISTINCT FROM 'worker' THEN RAISE EXCEPTION 'Worker required' USING ERRCODE='42501'; END IF;
 DELETE FROM rental_documents WHERE id=document_id AND purge_claimed_at IS NOT NULL AND deleted_at <= now()-interval '30 days';
END $$;
REVOKE ALL ON FUNCTION vault_claim_expired() FROM PUBLIC;
REVOKE ALL ON FUNCTION vault_finish_purge(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault_claim_expired(),vault_finish_purge(uuid) TO app_rt;
