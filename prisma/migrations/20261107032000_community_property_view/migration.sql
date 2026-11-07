-- Community may view the tenant's property inventory, including private listings;
-- contracts and rental administration remain inaccessible.
DROP POLICY administrative_inventory_private ON properties;
CREATE POLICY administrative_inventory_private ON properties AS RESTRICTIVE FOR SELECT USING
 (NOT administration_only OR (SELECT ctx_rol()) IN ('admin','agente','community','portal'));
