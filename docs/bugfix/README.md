# docs/bugfix — back-lamelas (API, datos y procesos)

Registro de bugs detectados en producción y la solución para cada uno, **de este
repo**. Los del panel van en `lamelas/docs/bugfix/`, los del sitio público en
`lamelas-web/docs/bugfix/` y los de Sofía/n8n en `lamelas-agent/docs/bugfix/`.

> **Cambio de alcance (2026-09-27).** Antes este directorio era el registro de los
> cuatro repos. Ahora cada repo tiene el suyo. El archivo de la carga manual de
> consultas, que era solo del panel, se movió a
> `lamelas/docs/bugfix/2026-08-13-carga-manual-consultas.md`. Los incidentes
> anteriores a esta fecha que tocaron más de un repo se conservan donde vivía el
> fix principal, sin partirlos: son historial.

Convención: un archivo por bug con nombre `AAAA-MM-DD-descripcion-corta.md`. Cada
archivo documenta síntoma, causa raíz (archivo/commit), por qué pasa, la solución
acordada, los archivos a tocar, la verificación y el estado
(pendiente / implementado / desplegado). Los items chicos y las mejoras sin
incidente asociado van inline en "Mejoras pendientes".

## Índice

- [2026-08-13 — Fotos lentas o que no cargan en Safari](./2026-08-13-fotos-lentas-safari.md) — **runbook listo, PENDIENTE de aplicar** (revalidado 2026-09-27)
- [2026-08-13 — Consultas del formulario web no aparecen en el panel](./2026-08-13-consultas-no-aparecen-en-panel.md) — **desplegado** (verificado 2026-09-27)
- [2026-08-13 — 500 al crear consulta web: SMTP dentro de la transacción (P2028)](./2026-08-13-500-lead-smtp-en-transaccion.md) — **desplegado** (verificado 2026-09-27)

SQL auxiliar: [`2026-08-13-fotos-safari-swap-host.sql`](./2026-08-13-fotos-safari-swap-host.sql)
(reescribe las URLs guardadas de `property_images` y `feedback_adjuntos` al dominio
propio; correr como el rol dueño de la base).

## Mejoras pendientes

Los items de conducta que requieren decisión o desarrollo viven en
[`../features.md`](../features.md), no acá. Resumen de los que hoy más pesan:

- `HANDOFF-EXHAUST-01` — cuando se agotan los vendedores, el lead queda sin
  responsable y sin alerta. **Prioritario desde el 2026-09-27**, cuando se activó
  el cron de vencidos en n8n y el caso pasó a ser alcanzable. Contexto del cron en
  `lamelas-agent/docs/bugfix/2026-09-27-cron-vencidos-sin-publicar.md`.
- `ZONA-NORMALIZE-01` — `properties.zona` tiene variantes del mismo barrio
  (`Barrio Norte` / `barrio norte` / `B° Norte`) que parten los conteos de
  analíticas, duplican el filtro del sitio y rompen el caso especial de zona norte
  del buscador del agente.
- `ZONA-ALIAS-01` — `NORTH_ZONE_ALIASES` tiene `"zon norte"`, que parece un typo
  de `"zona norte"`: un lead que pide "zona norte" hoy recibe cero resultados.
- `HANDOFF-IDEMP-01` / `HANDOFF-RACE-01` / `QUEUE-CLAIM-01` — riesgos de
  concurrencia; bajos mientras haya un solo cron y una sola réplica, pero
  documentados.

## Reglas aprendidas (no repetir)

- **Nunca** llamadas de red (SMTP/HTTP) dentro de una transacción interactiva de
  Prisma: el timeout de 5 s las hace expirar (P2028) y revierte el trabajo de base
  aunque el efecto externo ya haya salido. Efectos externos, siempre después del
  commit.
- Detrás de Traefik hace falta `app.set("trust proxy", 1)`, o `express-rate-limit`
  falla con `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` y toma la IP equivocada.
- Filtrar en el cliente lo que el servidor ya paginó y contó rompe la paginación:
  los filtros van en el `where` del servidor.
- Las URLs públicas de R2 se hornean al subir (`publicUrl()` en `src/lib/r2.ts`):
  cambiar `R2_PUBLIC_URL` no reescribe lo ya guardado. Cualquier cambio de host
  necesita el SQL de backfill.
- El backend no tiene cron propio: todo lo periódico que no sea un worker interno
  depende de un workflow de n8n **publicado**. Verificarlo es parte del deploy.
