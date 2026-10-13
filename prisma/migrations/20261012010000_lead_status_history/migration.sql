CREATE TABLE lead_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  from_state lead_estado NOT NULL,
  to_state lead_estado NOT NULL,
  operation text CHECK (operation IN ('venta', 'alquiler')),
  reason text CHECK (reason IN ('no_califica', 'sin_respuesta', 'sin_interes', 'presupuesto', 'eligio_otra', 'otro')),
  note text CHECK (length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_status_history_close_check CHECK (
    (to_state = 'ganada' AND operation IS NOT NULL AND reason IS NULL)
    OR (to_state = 'perdida' AND operation IS NULL AND reason IS NOT NULL)
    OR (to_state IN ('nueva', 'en_contacto') AND operation IS NULL AND reason IS NULL)
  )
);

CREATE INDEX lead_status_history_lead_id_created_at_idx
  ON lead_status_history (lead_id, created_at DESC);
CREATE INDEX lead_status_history_tenant_id_idx ON lead_status_history (tenant_id);

ALTER TABLE lead_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_status_history FORCE ROW LEVEL SECURITY;
REVOKE ALL ON lead_status_history FROM app_rt;
GRANT SELECT, INSERT ON lead_status_history TO app_rt;

CREATE POLICY lead_status_history_select ON lead_status_history FOR SELECT USING (
  tenant_id = ctx_tenant_id()
  AND (ctx_rol() = 'admin' OR (
    ctx_rol() = 'agente'
    AND EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id AND l.tenant_id = lead_status_history.tenant_id)
  ))
);

CREATE POLICY lead_status_history_insert ON lead_status_history FOR INSERT WITH CHECK (
  tenant_id = ctx_tenant_id()
  AND actor_id = ctx_user_id()
  AND ctx_rol() IN ('admin', 'agente')
  AND EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id AND l.tenant_id = lead_status_history.tenant_id)
);
