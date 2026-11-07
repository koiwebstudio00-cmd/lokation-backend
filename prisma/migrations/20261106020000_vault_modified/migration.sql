ALTER TABLE rental_documents ADD COLUMN updated_at timestamptz;
UPDATE rental_documents SET updated_at=created_at;
ALTER TABLE rental_documents ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE vault_folders ADD COLUMN updated_at timestamptz;
UPDATE vault_folders SET updated_at=created_at;
ALTER TABLE vault_folders ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL;
CREATE INDEX rental_documents_tenant_updated_idx ON rental_documents(tenant_id,updated_at DESC,id);
CREATE FUNCTION vault_touch_modified() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN NEW.updated_at=clock_timestamp(); ELSE NEW.updated_at=OLD.updated_at; END IF;
 RETURN NEW;
END $$;
-- After editor field guards: the timestamp is maintained by the database, not by clients.
CREATE TRIGGER zz_vault_touch_modified BEFORE UPDATE ON rental_documents FOR EACH ROW EXECUTE FUNCTION vault_touch_modified();
CREATE TRIGGER zz_vault_touch_modified BEFORE UPDATE ON vault_folders FOR EACH ROW EXECUTE FUNCTION vault_touch_modified();
