-- Normalización de `properties.zona` — FASE 1: solo variantes tipográficas.
--
-- Contexto (relevado el 2026-09-28 sobre producción, 412 propiedades):
--   73 sin zona · 44 ya con un valor exacto de la lista ZONAS ·
--   295 filas (122 valores distintos) con un valor fuera de la lista.
-- De esas 295, esta fase toca SOLO las 79 filas (19 valores) que son la misma
-- zona escrita distinto: mayúsculas, acentos o "B" por "Barrio". Es el único
-- subconjunto donde el mapeo es mecánico y no hay criterio comercial de por
-- medio. Las macro-zonas (Norte, Centro, Capital, Sur…) y las referencias que
-- no son zona (direcciones, esquinas, shoppings) NO se tocan acá.
--
-- Ejecutar como el rol DUEÑO de la base (el de las migraciones, ej. inmo_owner),
-- NO como app_rt: `properties` tiene RLS y app_rt sin tenant no ve nada.
--
-- Filas esperadas por UPDATE, en orden: 25, 24, 18, 3, 1, 2, 1, 2, 1, 2 = 79.
-- Si algún número no coincide, ROLLBACK y avisar antes de seguir.

BEGIN;

UPDATE properties SET zona = 'Barrio Norte'
WHERE btrim(zona) IN ('Barrio norte', 'B norte', 'B NORTE', 'Zona B norte');

UPDATE properties SET zona = 'Barrio Sur'
WHERE btrim(zona) IN ('Barrio sur', 'barrio sur', 'B sur');

UPDATE properties SET zona = 'Yerba Buena'
WHERE btrim(zona) IN ('Yerba buena', 'YERBA BUENA');

UPDATE properties SET zona = 'San Pablo'
WHERE btrim(zona) = 'SAN PABLO';

UPDATE properties SET zona = 'Villa Luján'
WHERE btrim(zona) = 'Villa Lujan';

UPDATE properties SET zona = 'Villa 9 de Julio'
WHERE btrim(zona) IN ('Villa 9 De Julio', 'Villa 9 de julio');

UPDATE properties SET zona = 'Las Talitas'
WHERE btrim(zona) = 'Las talitas';

UPDATE properties SET zona = 'Lomas de Tafí'
WHERE btrim(zona) IN ('lomas de tafi', 'Lomas de tafi');

UPDATE properties SET zona = 'Zona Quinta Agronómica'
WHERE btrim(zona) = 'Zona Quinta agronómica';

UPDATE properties SET zona = 'Zona Portal'
WHERE btrim(zona) IN ('Zona portal', 'Zona en portal');

-- Higiene: espacios sobrantes en cualquier zona (no cambia el texto en sí).
UPDATE properties SET zona = btrim(zona)
WHERE zona IS NOT NULL AND zona <> btrim(zona);

-- Revisá los counts de cada UPDATE contra la lista de arriba.
-- Si cuadran: COMMIT;  Si no: ROLLBACK;
COMMIT;

-- Verificación posterior (debería devolver 123 = 44 previas + 79 normalizadas):
--   SELECT count(*) FROM properties WHERE btrim(zona) = ANY(array[
--     'Barrio Norte','Barrio Sur','Microcentro','Parque 9 de Julio','Parque Avellaneda',
--     'Ciudadela','Villa 9 de Julio','Villa Luján','Zona Abasto','Zona Quinta Agronómica',
--     'Parque Guillermina','Zona Portal','Las Talitas','Lomas de Tafí','Tafí Viejo',
--     'Yerba Buena','La Banda del Río Salí','Alderetes','San Pablo','Lules','Monteros','Concepción']);
