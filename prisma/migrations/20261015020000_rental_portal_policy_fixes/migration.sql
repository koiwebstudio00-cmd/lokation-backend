DROP POLICY properties_portal_select ON properties;
CREATE POLICY properties_portal_select ON properties FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'portal'
  AND EXISTS (SELECT 1 FROM rental_contracts c WHERE c.property_id = properties.id
    AND portal_contract_role(c.id) IS NOT NULL)
);

DROP POLICY rental_people_portal_select ON rental_people;
CREATE POLICY rental_people_portal_select ON rental_people FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'portal'
  AND EXISTS (SELECT 1 FROM rental_contracts c WHERE
    (c.owner_person_id = rental_people.id OR c.tenant_person_id = rental_people.id)
    AND portal_contract_role(c.id) IS NOT NULL)
);

DROP POLICY rental_service_accounts_portal_select ON rental_service_accounts;
CREATE POLICY rental_service_accounts_portal_select ON rental_service_accounts FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'portal'
  AND active AND visibility <> 'interna' AND EXISTS (SELECT 1 FROM rental_contracts c
    WHERE c.property_id = rental_service_accounts.property_id AND c.status <> 'borrador'
      AND (rental_service_accounts.visibility = 'ambos'
        OR rental_service_accounts.visibility::text = portal_contract_role(c.id))
      AND portal_contract_role(c.id) IS NOT NULL)
);

CREATE POLICY rental_portal_accesses_admin_select ON rental_portal_accesses FOR SELECT USING (
  tenant_id = (SELECT ctx_tenant_id()) AND (SELECT ctx_rol()) = 'admin'
);
CREATE POLICY rental_portal_accounts_admin_select ON rental_portal_accounts FOR SELECT USING (
  (SELECT ctx_rol()) = 'admin' AND EXISTS (SELECT 1 FROM rental_portal_accesses a
    WHERE a.account_id = rental_portal_accounts.id AND a.tenant_id = (SELECT ctx_tenant_id()))
);
