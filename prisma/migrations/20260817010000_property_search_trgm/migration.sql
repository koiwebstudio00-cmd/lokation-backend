-- #8 Buscador natural: acelera las búsquedas por texto (ILIKE '%...%') del
-- catálogo con índices de trigramas (pg_trgm). No cambia datos ni el modelo
-- Prisma: son índices puros que Postgres usa para los `contains` de la búsqueda.
--
-- Todo va dentro de un bloque con manejo de excepción a propósito: si el motor
-- no tiene pg_trgm disponible (permisos / search_path), la migración NO falla y
-- el buscador sigue funcionando igual (scan secuencial; con ~240 propiedades es
-- instantáneo). Los índices se pueden crear más adelante cuando el catálogo
-- crezca.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  CREATE INDEX IF NOT EXISTS properties_titulo_trgm_idx
    ON properties USING gin (titulo gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS properties_descripcion_trgm_idx
    ON properties USING gin (descripcion gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS properties_zona_trgm_idx
    ON properties USING gin (zona gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS properties_ciudad_trgm_idx
    ON properties USING gin (ciudad gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS properties_direccion_trgm_idx
    ON properties USING gin (direccion gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pg_trgm no disponible (%). El buscador funciona igual sin el indice.', SQLERRM;
END $$;
