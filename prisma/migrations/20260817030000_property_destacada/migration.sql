-- Propiedades destacadas: el vendedor puede marcar una propiedad para que suba
-- al tope del listado de la web y de las que ofrece el agente de IA. El tope de
-- cuántas puede tener destacadas cada vendedor se controla en la aplicación.
-- Columna NOT NULL con default false: las existentes quedan sin destacar.
ALTER TABLE "properties"
  ADD COLUMN IF NOT EXISTS "destacada" boolean NOT NULL DEFAULT false;
