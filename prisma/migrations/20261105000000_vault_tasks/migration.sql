ALTER TABLE rental_documents ALTER COLUMN contract_id DROP NOT NULL;
ALTER TABLE rental_documents ADD COLUMN mime_type text NOT NULL DEFAULT 'application/pdf', ADD COLUMN original_name text;
ALTER TABLE rental_documents ADD CONSTRAINT independent_document_private CHECK (contract_id IS NOT NULL OR visibility = 'interna');
CREATE INDEX rental_documents_tenant_id_created_at_idx ON rental_documents(tenant_id, created_at DESC);
CREATE UNIQUE INDEX users_id_tenant_id_key ON users(id, tenant_id);
CREATE TABLE team_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 created_by_id uuid NOT NULL, assigned_to_id uuid NOT NULL,
 title text NOT NULL, description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'en_curso', 'completada', 'cancelada')),
 priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('baja', 'normal', 'alta')),
 due_date date, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(created_by_id, tenant_id) REFERENCES users(id, tenant_id),
 FOREIGN KEY(assigned_to_id, tenant_id) REFERENCES users(id, tenant_id)
);
CREATE INDEX team_tasks_tenant_id_status_due_date_idx ON team_tasks(tenant_id, status, due_date);
CREATE INDEX team_tasks_tenant_id_assigned_to_id_created_at_idx ON team_tasks(tenant_id, assigned_to_id, created_at DESC);
ALTER TABLE team_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_tasks FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON team_tasks TO app_rt;
CREATE POLICY task_admin ON team_tasks FOR ALL
 USING (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin')
 WITH CHECK (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin');
CREATE POLICY task_assignee_read ON team_tasks FOR SELECT USING
 (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'agente' AND assigned_to_id = (SELECT ctx_user_id()));
CREATE POLICY task_assignee_update ON team_tasks FOR UPDATE USING
 (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'agente' AND assigned_to_id = (SELECT ctx_user_id()))
 WITH CHECK (tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'agente' AND assigned_to_id = (SELECT ctx_user_id()));
-- Agents may change status, never assignment or administrative fields, even through direct SQL.
CREATE FUNCTION guard_task_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ctx_rol() = 'agente' AND (to_jsonb(NEW) - 'status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
   RAISE EXCEPTION 'Only task status can be changed' USING ERRCODE = '42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_update_guard BEFORE UPDATE ON team_tasks FOR EACH ROW EXECUTE FUNCTION guard_task_update();
