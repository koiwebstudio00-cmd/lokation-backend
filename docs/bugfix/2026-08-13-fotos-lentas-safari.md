# Fotos lentas o que no cargan en Safari

- **Detectado:** 2026-08-13 (reportado por el cliente)
- **Estado:** runbook listo; **pendiente de aplicar** (revalidado el 2026-09-27: sigue en `pub-…r2.dev`)
- **Repos/servicios:** Cloudflare R2 + DNS (Vercel) + backend (Dokploy env) + one-time SQL

## Síntoma
En Safari las fotos tardan mucho o no cargan (peor en fichas con muchas fotos).

## Causa raíz
Se sirven desde `R2_PUBLIC_URL = https://pub-…r2.dev` — endpoint público **de desarrollo**
de Cloudflare R2, que Cloudflare **throttlea** y no es para producción. Safari (menos
conexiones en paralelo, timeouts estrictos) es el que peor lo sufre.

## Detalle clave: cómo se guardan las URLs
Cada foto guarda en la BD la `r2_key` (ruta en el bucket) **y** la `url` absoluta con el
host horneado. Por eso cambiar `R2_PUBLIC_URL` solo afecta a las fotos NUEVAS; las viejas
siguen apuntando a `r2.dev` hasta que se reescriba su `url` (ver SQL). El dominio nuevo y
`r2.dev` sirven el MISMO bucket → nada se rompe mientras `r2.dev` siga habilitado.

## Runbook (orden importa — así no se rompe nada)
1. **Cloudflare:** conectar un dominio propio al bucket (ej. `fotos.inmobiliarialyc.com.ar`)
   en R2 → bucket → Settings → Custom Domains. Como el DNS del dominio está en **Vercel**,
   el custom domain de R2 necesita ese (sub)dominio administrado en Cloudflare → delegar el
   subdominio: en **Vercel DNS** agregar registros `NS` de `fotos` apuntando a los
   nameservers de Cloudflare, y en Cloudflare tener la zona `fotos.inmobiliarialyc.com.ar`.
2. **Verificar:** pegar en el navegador una URL de foto con el host nuevo
   (`https://fotos.inmobiliarialyc.com.ar/<r2_key>`) y confirmar que abre.
3. **SQL (fotos viejas):** correr `2026-08-13-fotos-safari-swap-host.sql` como rol dueño.
4. **Dokploy:** setear `R2_PUBLIC_URL=https://fotos.inmobiliarialyc.com.ar` (fotos nuevas) y
   redeploy del backend.
5. **NO** apagar el "Public Development URL" (`r2.dev`) hasta después del paso 3.
6. **Panel (Vercel):** agregar el host nuevo a `NEXT_PUBLIC_R2_HOST` (acepta varios
   separados por coma → dejar el nuevo y `pub-…r2.dev` durante la transición) y redeploy.
   Con `images.unoptimized: true` los `remotePatterns` no se aplican hoy, pero la variable
   queda correcta si alguna vez se reactiva la optimización. Ver `lamelas/next.config.ts`.
7. **Sitio público:** agregar `<link rel="preconnect">` al host nuevo en
   `lamelas-web/index.html` (y sacar el `preconnect` a Supabase, que quedó de una versión
   vieja). Registrado en `lamelas-web/docs/bugfix/README.md`.

## Alternativa (evita el SQL, más código)
Que la API arme la URL desde `r2_key` al leer (en vez de devolver la `url` guardada): así
cambiar `R2_PUBLIC_URL` arregla nuevas y viejas de una, sin SQL. Toca export/properties/
agent/images. Más robusto a futuro, pero más superficie que el SQL de una vez.

## Verificación
- URLs de `/v1/export/properties` apuntan al dominio propio, no a `*.r2.dev`.
- Ficha con varias fotos en Safari: carga estable.

## Revalidación 2026-09-27
- `R2_PUBLIC_URL` sigue siendo el endpoint `pub-ce447cb398f848b893911f0d983f9928.r2.dev`.
- Confirmado en código que la `url` absoluta se hornea al subir: `publicUrl()` en
  `src/lib/r2.ts`, usada por `modules/images/service.ts` y `modules/feedback/service.ts`.
  Son exactamente las dos tablas que reescribe el SQL de este runbook.
- El CORS del bucket **no** se toca: el `PUT` del navegador va a la URL prefirmada del
  endpoint S3 de la cuenta, no al dominio público.
- Con dominio propio conviene además una cache rule agresiva (1 año, immutable): las
  `r2_key` son uuid y nunca cambian.
- Bloquea parcialmente el preview de links en WhatsApp (`lamelas-web/docs/features.md` →
  `OG-DINAMICO-01`): conviene tener el dominio propio antes de que los crawlers empiecen a
  pedir la portada de cada propiedad.
