alter table tenants add column site_published boolean not null default false;

create index tenants_public_site_slug_idx on tenants (slug)
  where site_published = true and estado = 'activo';
