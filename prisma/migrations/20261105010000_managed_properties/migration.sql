ALTER TABLE properties ADD COLUMN managed boolean NOT NULL DEFAULT false,
 ADD COLUMN administration_only boolean NOT NULL DEFAULT false;
UPDATE properties SET managed = true WHERE id IN (SELECT property_id FROM rental_contracts);
CREATE INDEX properties_tenant_id_managed_idx ON properties(tenant_id, managed);
-- Restrictive policy composes with existing tenant policies. Administrative stock
-- must not be disclosed by the public website, exports or the conversational agent.
CREATE POLICY administrative_inventory_private ON properties AS RESTRICTIVE FOR SELECT USING
 (NOT administration_only OR (SELECT ctx_rol()) IN ('admin', 'agente', 'portal'));
CREATE POLICY administrative_images_private ON property_images AS RESTRICTIVE FOR SELECT USING
 (EXISTS (SELECT 1 FROM properties p WHERE p.id = property_id));
