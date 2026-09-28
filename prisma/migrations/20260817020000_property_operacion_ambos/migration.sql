-- #3 Propiedad con venta Y alquiler a la vez.
-- Se suma el valor 'ambos' al enum de operación y dos columnas para el precio de
-- alquiler. Convención: operacion=ambos → `precio`/`moneda` = venta y
-- `precio_alquiler`/`moneda_alquiler` = alquiler. Los alquileres viejos
-- (operacion=alquiler) siguen leyendo `precio` como alquiler: no se migran.
--
-- ADD VALUE es seguro (solo suma un valor al final del enum) y Postgres 12+ lo
-- permite dentro de una transacción mientras no se use en la misma (acá no).
ALTER TYPE "operacion_enum" ADD VALUE IF NOT EXISTS 'ambos';

ALTER TABLE "properties"
  ADD COLUMN IF NOT EXISTS "precio_alquiler" numeric(14, 2),
  ADD COLUMN IF NOT EXISTS "moneda_alquiler" "moneda_enum";
