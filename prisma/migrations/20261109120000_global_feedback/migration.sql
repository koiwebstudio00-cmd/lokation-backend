-- Only feedback is shared across tenants; user and business tables stay isolated.
ALTER TABLE feedback_items ADD COLUMN autor_nombre text NOT NULL DEFAULT '';
ALTER TABLE feedback_comentarios ADD COLUMN autor_nombre text NOT NULL DEFAULT '';
UPDATE feedback_items f SET autor_nombre=u.nombre FROM users u WHERE u.id=f.autor_id;
UPDATE feedback_comentarios f SET autor_nombre=u.nombre FROM users u WHERE u.id=f.autor_id;
DROP POLICY feedback_select ON feedback_items;
DROP POLICY community_feedback_read ON feedback_items;
CREATE POLICY feedback_select ON feedback_items FOR SELECT USING (
 ctx_user_id() IS NOT NULL AND ctx_rol() IN ('admin','agente','community','super_admin')
);
DROP POLICY feedback_update ON feedback_items;
CREATE POLICY feedback_update ON feedback_items FOR UPDATE USING (is_super_admin()) WITH CHECK (is_super_admin());
DROP POLICY feedback_delete ON feedback_items;
CREATE POLICY feedback_delete ON feedback_items FOR DELETE USING (is_super_admin());
DROP POLICY feedback_adjuntos_insert ON feedback_adjuntos;
CREATE POLICY feedback_adjuntos_insert ON feedback_adjuntos FOR INSERT WITH CHECK (
 EXISTS (SELECT 1 FROM feedback_items f WHERE f.id=feedback_id AND f.tenant_id=feedback_adjuntos.tenant_id
 AND (f.autor_id=ctx_user_id() OR is_super_admin()))
);
DROP POLICY feedback_adjuntos_delete ON feedback_adjuntos;
CREATE POLICY feedback_adjuntos_delete ON feedback_adjuntos FOR DELETE USING (
 EXISTS (SELECT 1 FROM feedback_items f WHERE f.id=feedback_id AND (f.autor_id=ctx_user_id() OR is_super_admin()))
);
