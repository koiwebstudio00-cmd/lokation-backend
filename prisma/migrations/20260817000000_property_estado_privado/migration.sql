-- #7 "Privado" como estado comercial.
-- Se agrega el valor 'privado' al enum de estado de propiedades. Una propiedad
-- privada NO se publica en la web pública (el export sigue pidiendo
-- estado=disponible), pero el agente de IA (Sofi) sí la puede ofrecer.
--
-- ADD VALUE es seguro y no requiere el patrón recreate: solo suma un valor al
-- final, no renombra ni elimina. Postgres 12+ permite ADD VALUE dentro de una
-- transacción siempre que el valor nuevo no se use en la misma transacción
-- (acá no se usa), así que corre sin problema con migrate deploy.
ALTER TYPE "estado_enum" ADD VALUE IF NOT EXISTS 'privado';
