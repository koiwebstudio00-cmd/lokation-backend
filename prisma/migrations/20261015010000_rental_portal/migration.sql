CREATE TABLE rental_portal_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rental_portal_accesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES rental_portal_accounts(id) ON DELETE CASCADE,
  person_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rental_portal_accesses_person_tenant_fkey FOREIGN KEY (person_id, tenant_id)
    REFERENCES rental_people(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, person_id)
);
CREATE INDEX rental_portal_accesses_account_tenant_active_idx ON rental_portal_accesses (account_id, tenant_id, active);
CREATE TABLE rental_portal_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  person_id uuid NOT NULL,
  created_by_id uuid NOT NULL REFERENCES users(id),
  email citext NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rental_portal_invitations_person_tenant_fkey FOREIGN KEY (person_id, tenant_id)
    REFERENCES rental_people(id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX rental_portal_invitations_tenant_person_created_idx ON rental_portal_invitations
  (tenant_id, person_id, created_at DESC);
CREATE TABLE rental_portal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES rental_portal_accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rental_portal_sessions_account_tenant_expires_idx ON rental_portal_sessions
  (account_id, tenant_id, expires_at);

CREATE TABLE rental_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES rental_portal_accounts(id),
  category text NOT NULL CHECK (category IN ('consulta', 'reclamo')),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 5 AND 160),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 10 AND 5000),
  status text NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta', 'en_gestion', 'resuelta')),
  response text CHECK (response IS NULL OR length(trim(response)) BETWEEN 5 AND 5000),
  answered_by_id uuid REFERENCES users(id),
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rental_inquiries_contract_tenant_fkey FOREIGN KEY (contract_id, tenant_id)
    REFERENCES rental_contracts(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT rental_inquiries_answer_state_check CHECK ((response IS NULL AND answered_by_id IS NULL AND answered_at IS NULL)
    OR (response IS NOT NULL AND answered_by_id IS NOT NULL AND answered_at IS NOT NULL))
);
CREATE INDEX rental_inquiries_tenant_status_created_idx ON rental_inquiries (tenant_id, status, created_at DESC);
CREATE INDEX rental_inquiries_contract_created_idx ON rental_inquiries (contract_id, created_at DESC);

CREATE TABLE rental_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  uploaded_by_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 160),
  kind text NOT NULL CHECK (kind IN ('contrato', 'comprobante', 'inventario', 'otro')),
  visibility text NOT NULL CHECK (visibility IN ('interna', 'inquilino', 'propietario', 'ambos')),
  storage_key text NOT NULL UNIQUE,
  size integer NOT NULL CHECK (size BETWEEN 1 AND 10485760),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rental_documents_contract_tenant_fkey FOREIGN KEY (contract_id, tenant_id)
    REFERENCES rental_contracts(id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX rental_documents_contract_created_idx ON rental_documents (contract_id, created_at DESC);

ALTER TABLE rental_portal_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_portal_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE rental_portal_accesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_portal_accesses FORCE ROW LEVEL SECURITY;
ALTER TABLE rental_portal_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_portal_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE rental_portal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_portal_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE rental_inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_inquiries FORCE ROW LEVEL SECURITY;
ALTER TABLE rental_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_documents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON rental_portal_accounts, rental_portal_accesses, rental_portal_invitations,
  rental_portal_sessions, rental_inquiries, rental_documents FROM app_rt;
GRANT SELECT, INSERT, UPDATE, DELETE ON rental_portal_accounts, rental_portal_accesses,
  rental_portal_invitations, rental_portal_sessions TO app_rt;
GRANT SELECT, INSERT ON rental_inquiries, rental_documents TO app_rt;
GRANT UPDATE (status, response, answered_by_id, answered_at) ON rental_inquiries TO app_rt;
GRANT DELETE ON rental_documents TO app_rt;

CREATE POLICY rental_portal_accounts_auth ON rental_portal_accounts FOR ALL
  USING ((SELECT ctx_rol()) = 'auth') WITH CHECK ((SELECT ctx_rol()) = 'auth');
CREATE POLICY rental_portal_accesses_auth ON rental_portal_accesses FOR ALL
  USING ((SELECT ctx_rol()) = 'auth') WITH CHECK ((SELECT ctx_rol()) = 'auth');
CREATE POLICY rental_portal_invitations_auth ON rental_portal_invitations FOR ALL
  USING ((SELECT ctx_rol()) = 'auth') WITH CHECK ((SELECT ctx_rol()) = 'auth');
CREATE POLICY rental_portal_sessions_auth ON rental_portal_sessions FOR ALL
  USING ((SELECT ctx_rol()) = 'auth') WITH CHECK ((SELECT ctx_rol()) = 'auth');
CREATE POLICY rental_people_auth_select ON rental_people FOR SELECT USING ((SELECT ctx_rol()) = 'auth');

-- SECURITY DEFINER evita recursión de las policies de contratos; la función
-- siempre exige la identidad, tenant y rol del contexto autenticado.
CREATE FUNCTION portal_contract_role(p_contract_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN c.owner_person_id = a.person_id THEN 'propietario'
              WHEN c.tenant_person_id = a.person_id THEN 'inquilino' END
  FROM rental_contracts c
  JOIN rental_portal_accesses a ON a.tenant_id = c.tenant_id
    AND a.person_id IN (c.owner_person_id, c.tenant_person_id)
  JOIN rental_portal_accounts u ON u.id = a.account_id
  JOIN tenants t ON t.id = c.tenant_id
  WHERE c.id = p_contract_id AND c.tenant_id = ctx_tenant_id()
    AND ctx_rol() = 'portal' AND a.account_id = ctx_user_id()
    AND a.active AND u.active AND t.estado = 'activo' AND c.status <> 'borrador'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION portal_contract_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal_contract_role(uuid) TO app_rt;

CREATE POLICY rental_contracts_portal_select ON rental_contracts FOR SELECT USING
  (portal_contract_role(id) IS NOT NULL);
CREATE POLICY properties_portal_select ON properties FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'portal'
  AND EXISTS (SELECT 1 FROM rental_contracts c WHERE c.property_id = id AND portal_contract_role(c.id) IS NOT NULL)
);
CREATE POLICY rental_people_portal_select ON rental_people FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'portal'
  AND EXISTS (SELECT 1 FROM rental_contracts c WHERE
    (c.owner_person_id = id OR c.tenant_person_id = id) AND portal_contract_role(c.id) IS NOT NULL)
);
CREATE POLICY rental_charges_portal_select ON rental_charges FOR SELECT USING
  (portal_contract_role(contract_id) IS NOT NULL);
CREATE POLICY rental_payments_portal_select ON rental_payments FOR SELECT USING (
  (SELECT ctx_rol()) = 'portal' AND EXISTS (SELECT 1 FROM rental_charges c
    WHERE c.id = charge_id AND portal_contract_role(c.contract_id) = 'inquilino')
);
CREATE POLICY rental_adjustments_portal_select ON rental_adjustments FOR SELECT USING
  (portal_contract_role(contract_id) IS NOT NULL);
CREATE POLICY rental_settlements_portal_select ON rental_settlements FOR SELECT USING
  (portal_contract_role(contract_id) = 'propietario' AND status <> 'cancelada');
CREATE POLICY rental_service_accounts_portal_select ON rental_service_accounts FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'portal'
  AND active AND visibility <> 'interna' AND EXISTS (SELECT 1 FROM rental_contracts c
    WHERE c.property_id = property_id AND c.status <> 'borrador'
      AND (visibility = 'ambos' OR visibility::text = portal_contract_role(c.id))
      AND portal_contract_role(c.id) IS NOT NULL)
);
CREATE POLICY maintenance_requests_portal_select ON maintenance_requests FOR SELECT USING (
  contract_id IS NOT NULL AND portal_contract_role(contract_id) IS NOT NULL
);
CREATE POLICY maintenance_events_portal_select ON maintenance_events FOR SELECT USING (
  (SELECT ctx_rol()) = 'portal' AND EXISTS (SELECT 1 FROM maintenance_requests m WHERE m.id = request_id)
);
CREATE POLICY rental_inquiries_admin_select ON rental_inquiries FOR SELECT USING
  (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin');
CREATE POLICY rental_inquiries_admin_update ON rental_inquiries FOR UPDATE USING
  (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin')
  WITH CHECK (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
    AND (answered_by_id IS NULL OR answered_by_id = (SELECT ctx_user_id())));
CREATE POLICY rental_inquiries_portal_select ON rental_inquiries FOR SELECT USING
  (account_id = (SELECT ctx_user_id()) AND portal_contract_role(contract_id) IS NOT NULL);
CREATE POLICY rental_inquiries_portal_insert ON rental_inquiries FOR INSERT WITH CHECK
  (tenant_id = (SELECT ctx_tenant_id()) AND account_id = (SELECT ctx_user_id())
    AND portal_contract_role(contract_id) IS NOT NULL AND status = 'abierta'
    AND response IS NULL AND answered_by_id IS NULL AND answered_at IS NULL);
CREATE POLICY rental_documents_admin_all ON rental_documents FOR ALL USING
  (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin')
  WITH CHECK (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
    AND uploaded_by_id = (SELECT ctx_user_id()));
CREATE POLICY rental_documents_portal_select ON rental_documents FOR SELECT USING (
  (SELECT ctx_rol()) = 'portal' AND
  (visibility = 'ambos' OR visibility = portal_contract_role(contract_id))
  AND portal_contract_role(contract_id) IS NOT NULL
);
