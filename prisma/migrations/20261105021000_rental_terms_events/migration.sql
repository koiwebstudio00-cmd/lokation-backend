ALTER TABLE rental_contract_events DROP CONSTRAINT rental_contract_events_action_check;
ALTER TABLE rental_contract_events ADD CONSTRAINT rental_contract_events_action_check
 CHECK (action IN ('edited', 'activated', 'finished', 'terms_changed'));
