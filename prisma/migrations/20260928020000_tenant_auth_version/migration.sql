-- Toda suspensión invalida los JWT emitidos antes, incluso si el tenant se
-- reactiva durante los 15 minutos de vida del access token.
alter table tenants add column auth_version integer not null default 0;
