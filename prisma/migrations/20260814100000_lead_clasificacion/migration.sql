-- Clasificación del lead: "potencial" (cliente potencial) vs "fantasma"
-- (curioso). La pone el agente al conversar y el vendedor la puede corregir
-- desde el panel. Sirve para medir cuántos potenciales vs fantasmas entran.
-- Nullable: un lead arranca sin clasificar. Aditivo; los grants de `leads` a
-- app_rt ya cubren la columna nueva.

create type lead_clasificacion as enum ('potencial', 'fantasma');

alter table leads add column clasificacion lead_clasificacion;
