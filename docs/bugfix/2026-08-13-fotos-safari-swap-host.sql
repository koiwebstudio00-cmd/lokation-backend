-- Fotos: mover las URLs guardadas del host lento (pub-*.r2.dev) al dominio propio.
-- Se apoya en que cada fila guarda la r2_key: reescribe SOLO el prefijo del host,
-- apuntando al MISMO archivo del bucket. No toca fotos heredadas de Supabase
-- (esas no contienen "r2.dev").
--
-- CORRER DESPUES de que el dominio nuevo ya sirva el bucket (paso 2 del runbook).
-- Ejecutar como el rol DUEÑO de la base (el de las migraciones, ej. app_owner /
-- superuser), NO como app_rt: property_images y feedback_adjuntos tienen RLS.
-- Si elegís otro subdominio, cambiá 'fotos.inmobiliarialyc.com.ar' abajo.

-- 1) Previsualizar cuántas filas se van a tocar (opcional):
--    SELECT count(*) FROM property_images  WHERE url LIKE '%r2.dev/%';
--    SELECT count(*) FROM feedback_adjuntos WHERE url LIKE '%r2.dev/%';

BEGIN;

UPDATE property_images
SET url = 'https://fotos.inmobiliarialyc.com.ar/' || r2_key
WHERE url LIKE '%r2.dev/%';

UPDATE feedback_adjuntos
SET url = 'https://fotos.inmobiliarialyc.com.ar/' || r2_key
WHERE url LIKE '%r2.dev/%';

-- Revisá los counts que devolvió cada UPDATE. Si algo no cuadra: ROLLBACK;
COMMIT;
