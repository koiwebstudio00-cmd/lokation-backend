# Consultas del formulario web no aparecen en el panel

- **Detectado:** 2026-08-13 (reportado por el cliente: desde ~05/08 no se ven consultas nuevas)
- **Estado:** implementado 2026-08-13 · **en `origin/main`, desplegado** (verificado 2026-09-27)
- **Repos afectados:** `back-lamelas` (fix principal) · `lamelas` (limpieza cliente)

## Síntoma

Las consultas cargadas desde el formulario del sitio público dejaron de aparecer en
`/consultas` del panel. **Sí se estaban creando**: llegaban por email (aviso de
`notifyLead`) y quedaban en la base. El "N en total" del listado tampoco coincidía con
las filas mostradas.

## Causa raíz

Commit **c3ebda2 (2026-08-07, "agente web")** en `lamelas/src/lib/queries.ts`. Al separar
las conversaciones del agente del panel de leads, se filtró **en el cliente, después de
que el backend ya paginó y contó**:

```ts
// getLeads()
const leads = data.map(toLead).filter((l) => !(l.canal_ref ?? "").startsWith("prueba-"));
return { leads, count: meta.total, page: meta.page }; // count = total SIN filtrar
```

- `listLeads` (backend) NO separa nada: trae las `PAGE_SIZE = 24` más nuevas por
  `createdAt desc`.
- El agente (probador y agente web) crea leads con `canal="web"` y `canal_ref` = session_id
  (los de prueba: `prueba-...`). Cada prueba genera uno nuevo y son los más recientes.
- Como el filtro corre sobre la página ya traída pero `count = meta.total` (sin filtrar),
  cada lead de agente/prueba dentro de las 24 más nuevas se descarta de la vista pero igual
  ocupa slot y suma al conteo → las consultas reales nuevas quedan empujadas fuera de la
  página visible y el total no coincide.
- `getResumen()` ("últimas consultas" del inicio) tiene el MISMO filtro cliente y el mismo
  problema.

Descartado (diagnóstico previo erróneo): no es CORS ni slug/estado del tenant. Los leads
se insertan bien.

## Distinción de datos (por qué el fix es simple)

| Origen | `canal` | `canal_ref` |
|---|---|---|
| Formulario web (consulta real) | `web` | **NULL** |
| Agente web (real) | `web` | seteado (session_id) |
| Agente web (prueba) | `web` | `prueba-…` |
| Agente WhatsApp | `whatsapp` | teléfono |
| Carga manual | `manual` | NULL |

La única colisión es `canal="web"` (formulario vs agente web), y ahí ya se distinguen:
**formulario = `canal_ref` NULL**, **agente web = `canal_ref` no-NULL**.

## Solución a implementar

Decisión de producto: `/consultas` muestra **formulario + WhatsApp + manual**, y saca solo
el **agente web + pruebas**. Eso equivale a excluir exactamente `canal='web' AND canal_ref
IS NOT NULL`. No requiere prefijo nuevo ni cambios en n8n.

Hacer la separación **en el servidor**, para que paginación y conteo queden correctos.

### `back-lamelas`
- `src/modules/crm/service.ts` → `listLeads`: nuevo filtro opcional (ej. `excluirAgenteWeb`)
  que agrega al `where` de Prisma:
  `NOT: { canal: "web", canalRef: { not: null } }`.
- `src/modules/crm/routes.ts` → `GET /leads`: aceptar el query param (ej.
  `excluir_agente_web=true`, Zod `coerce.boolean`) y pasarlo a `listLeads`.
- **No** aplicarlo por defecto: el probador (`getConversacionesPrueba`) consulta
  `/v1/leads?canal=web` y necesita ver los `prueba-`. El flag es opt-in.

### `lamelas` (panel)
- `src/lib/queries.ts` → `getLeads`: pasar `excluir_agente_web=true` y **borrar** el
  `.filter(... "prueba-")` cliente.
- `src/lib/queries.ts` → `getResumen`: idem en la consulta de "últimas consultas" (pasar el
  flag, borrar el `.filter`). Revisar el contador `consultasNuevas` para que use el mismo
  criterio.
- `getConversacionesPrueba` queda igual (sigue queriendo los `prueba-`).

## Verificación
- `back-lamelas`: `npm run lint && npx tsc --noEmit && npm run build && npm test`
  (correr la suite; el listado de leads no cambia RLS pero el test de leads cubre el filtro).
- `lamelas`: `npm run lint && npx tsc --noEmit && npm run build`.
- Manual: con al menos un lead de formulario (canal_ref null) y uno de agente web
  (canal_ref no-null), confirmar que en `/consultas` aparece el primero y no el segundo, y
  que "N en total" coincide con las filas.

## Implementado (2026-08-13)

- `back-lamelas`: `crm/service.ts` (filtro `excluirAgenteWeb` → `NOT: { canal: "web", canalRef: { not: null } }`) y `crm/routes.ts` (query param `excluir_agente_web`, opt-in).
- `lamelas`: `queries.ts` → `getLeads` y `getResumen` mandan `excluir_agente_web: true` y se borró el `.filter("prueba-")` cliente. `getConversacionesPrueba` quedó igual.
- **Verificado:** `tsc --noEmit` y `eslint` OK en ambos repos; `build` del backend OK.
- **No verificado en este entorno (limitación del bridge, sin red / node_modules de otra arch):** `next build` del panel (falla al bajar la fuente Inter de Google Fonts — buildea bien en Vercel) y `npm test` del backend (falta binario nativo de rollup). Correr `npm test` en local/CI antes del deploy.
