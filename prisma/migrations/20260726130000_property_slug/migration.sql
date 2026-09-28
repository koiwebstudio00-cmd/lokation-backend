-- 0010 property slug — identificador público para las URLs de la web.
-- Paridad exacta con la migración 0003 del MVP Supabase: misma fórmula
-- ({operacion}-{titulo_slugificado}-{id_corto}) y mismo trigger. Como la
-- migración de datos preserva los ids, los slugs generados acá resultan
-- IDÉNTICOS a los de Supabase → ninguna URL pública de lamelas-web se rompe.
-- El slug NO se regenera en updates: la URL queda estable aunque cambie el título.

create extension if not exists unaccent;

-- Slugify: minúsculas, sin acentos, solo [a-z0-9] y guiones
create function slugify(t text) returns text language sql stable as $$
  select trim(both '-' from regexp_replace(lower(unaccent(coalesce(t, ''))), '[^a-z0-9]+', '-', 'g'));
$$;

-- Base del slug: operacion + titulo, recortada sin cortar palabras de más
create function property_slug_base(op operacion_enum, titulo text) returns text
language sql stable as $$
  select trim(both '-' from left(
    concat_ws('-', lower(op::text), nullif(slugify(titulo), '')),
    60
  ));
$$;

-- default '' (no null): Prisma manda '' en los INSERT y el trigger lo completa
alter table properties add column slug text not null default '';

-- Backfill de filas existentes
update properties
set slug = property_slug_base(operacion, titulo) || '-' || left(id::text, 8)
where slug = '';

-- Autogenerar en inserts cuando no viene slug (o viene vacío)
create function set_property_slug() returns trigger language plpgsql as $$
begin
  if new.slug is null or new.slug = '' then
    new.slug := property_slug_base(new.operacion, new.titulo) || '-' || left(new.id::text, 8);
  end if;
  return new;
end $$;

create trigger properties_set_slug
  before insert on properties
  for each row execute function set_property_slug();

-- Único (identificador de URLs públicas). Nombre estilo Prisma para que el
-- diff de schema.prisma quede alineado.
create unique index properties_slug_key on properties (slug);
