-- 0016 property requisitos — requisitos de alquiler que carga el vendedor.
-- A diferencia de `notas` (info interna del equipo), esto es información
-- PÚBLICA: el agente la comparte cuando le preguntan qué piden para alquilar,
-- y por eso sí sale por las tools del agente (ver módulo agent).
alter table properties add column requisitos text;
