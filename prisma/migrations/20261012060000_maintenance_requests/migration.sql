CREATE TYPE maintenance_status AS ENUM ('abierta', 'en_gestion', 'resuelta', 'cancelada');
CREATE TYPE maintenance_priority AS ENUM ('baja', 'normal', 'alta', 'urgente');

ALTER TABLE rental_contracts ADD CONSTRAINT rental_contracts_id_property_tenant_key
  UNIQUE (id, property_id, tenant_id);

CREATE TABLE maintenance_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  contract_id uuid,
  created_by_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 5000),
  priority maintenance_priority NOT NULL DEFAULT 'normal',
  status maintenance_status NOT NULL DEFAULT 'abierta',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT maintenance_requests_property_tenant_fkey FOREIGN KEY (property_id, tenant_id)
    REFERENCES properties(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT maintenance_requests_contract_property_tenant_fkey FOREIGN KEY (contract_id, property_id, tenant_id)
    REFERENCES rental_contracts(id, property_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT maintenance_requests_resolution_check CHECK (
    (status = 'resuelta' AND resolved_at IS NOT NULL) OR
    (status <> 'resuelta' AND resolved_at IS NULL)
  ),
  UNIQUE (id, tenant_id)
);

CREATE TABLE maintenance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  from_state maintenance_status,
  to_state maintenance_status NOT NULL,
  note text NOT NULL CHECK (length(trim(note)) BETWEEN 5 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_events_request_tenant_fkey FOREIGN KEY (request_id, tenant_id)
    REFERENCES maintenance_requests(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX maintenance_requests_tenant_status_created_idx ON maintenance_requests
  (tenant_id, status, created_at DESC);
CREATE INDEX maintenance_requests_property_tenant_idx ON maintenance_requests (property_id, tenant_id);
CREATE INDEX maintenance_events_request_created_idx ON maintenance_events (request_id, created_at DESC);
CREATE INDEX maintenance_events_tenant_created_idx ON maintenance_events (tenant_id, created_at DESC);

ALTER TABLE maintenance_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE maintenance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON maintenance_requests, maintenance_events FROM app_rt;
GRANT SELECT, INSERT ON maintenance_requests, maintenance_events TO app_rt;
GRANT UPDATE (status, resolved_at, updated_at) ON maintenance_requests TO app_rt;

CREATE POLICY maintenance_requests_select ON maintenance_requests FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);
CREATE POLICY maintenance_requests_insert ON maintenance_requests FOR INSERT WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id()) AND created_by_id = (SELECT ctx_user_id())
  AND (SELECT ctx_rol()) = 'admin'
);
CREATE POLICY maintenance_requests_update ON maintenance_requests FOR UPDATE USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
) WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);
CREATE POLICY maintenance_events_select ON maintenance_events FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);
CREATE POLICY maintenance_events_insert ON maintenance_events FOR INSERT WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id()) AND actor_id = (SELECT ctx_user_id())
  AND (SELECT ctx_rol()) = 'admin'
);
