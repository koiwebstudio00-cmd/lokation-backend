CREATE TYPE rental_person_role AS ENUM ('propietario', 'inquilino', 'garante', 'contacto');

CREATE TABLE rental_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by_id uuid NOT NULL REFERENCES users(id),
  nombre text NOT NULL CHECK (length(trim(nombre)) BETWEEN 1 AND 200),
  email text CHECK (email IS NULL OR length(email) <= 320),
  telefono text CHECK (telefono IS NULL OR length(telefono) <= 50),
  roles rental_person_role[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rental_people_tenant_id_nombre_idx ON rental_people (tenant_id, nombre);

ALTER TABLE rental_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_people FORCE ROW LEVEL SECURITY;
REVOKE ALL ON rental_people FROM app_rt;
GRANT SELECT, INSERT ON rental_people TO app_rt;
GRANT UPDATE (nombre, email, telefono, roles, updated_at) ON rental_people TO app_rt;

CREATE POLICY rental_people_select ON rental_people FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);

CREATE POLICY rental_people_insert ON rental_people FOR INSERT WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id())
  AND created_by_id = (SELECT ctx_user_id())
  AND (SELECT ctx_rol()) = 'admin'
);

CREATE POLICY rental_people_update ON rental_people FOR UPDATE USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
) WITH CHECK (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);
