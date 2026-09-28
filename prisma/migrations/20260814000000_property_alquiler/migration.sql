-- Feature: campos de alquiler en propiedades.
--
-- 1) Se AMPLÍAN los enums `tipo_enum` y `estado_enum` con los valores nuevos
--    (y se renombra 'local' -> 'local_comercial', 'reservada' -> 'reservado').
--    Se recrean por completo — en vez de ALTER TYPE ADD VALUE — para poder
--    renombrar valores y evitar la limitación de "ADD VALUE dentro de una
--    transacción". Se preserva la data existente con un mapeo.
-- 2) Se crean enums nuevos para los campos discretos de alquiler.
-- 3) Se agregan las columnas de alquiler (nullable) + lat/lng para el mapa.
--
-- Aditivo: no rompe /v1 ni el export. REVISAR este SQL antes de `migrate deploy`.

-- ── tipo_enum: recrear con los valores nuevos ────────────────────────────────
alter type tipo_enum rename to tipo_enum_old;
create type tipo_enum as enum (
  'monoambiente',
  'departamento',
  'casa',
  'duplex',
  'local_comercial',
  'oficina',
  'galpon',
  'estacionamiento',
  'terreno',
  'otro'
);
alter table properties
  alter column tipo type tipo_enum
  using (case tipo::text when 'local' then 'local_comercial' else tipo::text end)::tipo_enum;
drop type tipo_enum_old;

-- ── estado_enum: recrear (reservada -> reservado; + proximamente/pausado/alquilada)
alter type estado_enum rename to estado_enum_old;
create type estado_enum as enum (
  'disponible',
  'reservado',
  'proximamente',
  'pausado',
  'vendida',
  'alquilada'
);
alter table properties alter column estado drop default;
alter table properties
  alter column estado type estado_enum
  using (case estado::text when 'reservada' then 'reservado' else estado::text end)::estado_enum;
alter table properties alter column estado set default 'disponible'::estado_enum;
drop type estado_enum_old;

-- ── enums nuevos para los campos discretos de alquiler ───────────────────────
create type destino_enum        as enum ('vivienda', 'comercial', 'profesional', 'otro');
create type plazo_contrato_enum as enum ('meses_12', 'meses_18', 'meses_24', 'meses_36', 'otro');
create type ajuste_enum         as enum ('trimestral', 'cuatrimestral', 'otro');
create type indice_ajuste_enum  as enum ('icl', 'ipc', 'fijo');
create type mascotas_enum        as enum ('se_permiten', 'no_se_permiten', 'sin_especificar');
create type amoblado_enum        as enum ('amoblado', 'sin_amoblar', 'sin_especificar');

-- ── columnas nuevas (todas nullable) ─────────────────────────────────────────
-- Los grants de tabla de `properties` a app_rt ya cubren estas columnas nuevas.
alter table properties
  add column destino          destino_enum,
  add column plazo_contrato   plazo_contrato_enum,
  add column plazo_otro       text,
  add column ajuste           ajuste_enum,
  add column ajuste_otro      text,
  add column indice_ajuste    indice_ajuste_enum,
  add column indice_fijo_pct  numeric(5, 2),
  add column expensas         text,
  add column mascotas         mascotas_enum,
  add column amoblado         amoblado_enum,
  add column lat              numeric(9, 6),
  add column lng              numeric(9, 6);
