CREATE TABLE notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL, body text NOT NULL, href text NOT NULL,
 read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_id_created_at_id_idx ON notifications(user_id, created_at DESC, id);
CREATE INDEX notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
REVOKE ALL ON notifications FROM app_rt;
GRANT SELECT ON notifications TO app_rt;
GRANT UPDATE(read_at) ON notifications TO app_rt;
CREATE POLICY own_notifications ON notifications FOR SELECT USING (
 user_id = ctx_user_id() AND (
 (ctx_rol() IN ('admin','agente') AND tenant_id = ctx_tenant_id()) OR
 (ctx_rol() = 'super_admin' AND tenant_id IS NULL))
);
CREATE POLICY read_own_notifications ON notifications FOR UPDATE USING (
 user_id = ctx_user_id() AND (
 (ctx_rol() IN ('admin','agente') AND tenant_id = ctx_tenant_id()) OR
 (ctx_rol() = 'super_admin' AND tenant_id IS NULL))
) WITH CHECK (user_id = ctx_user_id());

-- Sólo triggers internos crean avisos. No hay endpoint para elegir destinatarios.
CREATE FUNCTION notify_lead_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
 IF NEW.canal = 'web' AND NEW.canal_ref IS NOT NULL THEN RETURN NEW; END IF;
 IF TG_OP = 'INSERT' THEN
  INSERT INTO notifications(tenant_id,user_id,title,body,href)
  SELECT NEW.tenant_id,u.id,'Nueva consulta','Ingresó una consulta para tu inmobiliaria.','/consultas/' || NEW.id
  FROM users u WHERE u.tenant_id = NEW.tenant_id AND u.estado = 'activo' AND u.deleted_at IS NULL
   AND (u.rol = 'admin' OR u.id = NEW.assigned_to);
 ELSIF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to AND NEW.assigned_to IS NOT NULL THEN
  INSERT INTO notifications(tenant_id,user_id,title,body,href)
  SELECT NEW.tenant_id,u.id,'Consulta asignada','Tenés una consulta asignada para atender.','/consultas/' || NEW.id
  FROM users u WHERE u.id = NEW.assigned_to AND u.tenant_id = NEW.tenant_id AND u.estado = 'activo' AND u.deleted_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION notify_lead_change() FROM PUBLIC;
CREATE TRIGGER notify_lead AFTER INSERT OR UPDATE OF assigned_to ON leads FOR EACH ROW EXECUTE FUNCTION notify_lead_change();

CREATE FUNCTION notify_tenant_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  INSERT INTO notifications(user_id,title,body,href)
  SELECT id,'Nueva inmobiliaria',NEW.nombre || ' se registró en la plataforma.','/inmobiliarias/' || NEW.id
  FROM users WHERE rol='super_admin' AND estado='activo' AND deleted_at IS NULL;
 ELSE
  IF NEW.estado IS DISTINCT FROM OLD.estado OR NEW.site_published IS DISTINCT FROM OLD.site_published THEN
   INSERT INTO notifications(user_id,title,body,href)
   SELECT id,'Inmobiliaria actualizada',NEW.nombre || ': ' || NEW.estado || ', sitio ' || CASE WHEN NEW.site_published THEN 'publicado.' ELSE 'en borrador.' END,'/inmobiliarias/' || NEW.id
   FROM users WHERE rol='super_admin' AND estado='activo' AND deleted_at IS NULL;
  END IF;
  IF NEW.site_published IS DISTINCT FROM OLD.site_published THEN
   INSERT INTO notifications(tenant_id,user_id,title,body,href)
   SELECT NEW.id,id,'Sitio web actualizado',CASE WHEN NEW.site_published THEN 'Tu sitio web está publicado.' ELSE 'Tu sitio web volvió a borrador.' END,'/mi-sitio'
   FROM users WHERE tenant_id=NEW.id AND rol='admin' AND estado='activo' AND deleted_at IS NULL;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION notify_tenant_change() FROM PUBLIC;
CREATE TRIGGER notify_tenant AFTER INSERT OR UPDATE OF estado, site_published ON tenants FOR EACH ROW EXECUTE FUNCTION notify_tenant_change();
