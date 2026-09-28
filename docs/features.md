# Features por implementar — back-lamelas (API, datos y procesos)

**Última revisión:** 2026-09-27

Backlog exclusivo de **este repo**. Cuando una feature se implementa y queda
verificada, se saca de acá: el detalle histórico vive en commits y en
`docs/bugfix/`.

Las features que también necesitan trabajo en otro repo se registran en cada uno
por separado, con el mismo ID para poder cruzarlas:
`lamelas/docs/features.md` (panel), `lamelas-web/docs/features.md` (sitio),
`lamelas-agent/docs/features.md` (Sofía y n8n).

Formato de cada item: **qué es**, **ventaja** de hacerlo, **viabilidad**
(esfuerzo S/M/L, riesgo y qué se toca) y **estado**.

## Índice

| ID | Item | Esfuerzo | Estado |
|---|---|:---:|---|
| HANDOFF-EXHAUST-01 | Cierre/escalamiento cuando se agotan los vendedores | M | pendiente — prioritario |
| LEAD-WEB-HANDOFF-01 | Handoff + timeout para los leads del formulario web | L | pendiente (plan escrito) |
| CLASIF-PROPIETARIO-01 | Clasificar leads que vienen a dejar una propiedad | S/M | pendiente |
| ZONA-NORMALIZE-01 | Normalizar los valores de `properties.zona` | M | fase 1 lista, fases 2-3 a decidir |
| ZONA-ALIAS-01 | Corregir los alias de zona norte del buscador del agente | S | pendiente |
| EVENT-CATALOG-01 | Publicar `lead.assigned` en el catálogo suscribible | S | pendiente |
| HANDOFF-IDEMP-01 | Impedir handoffs pendientes duplicados | M | pendiente |
| WEBHOOK-HYGIENE-01 | Implementar o retirar la política de auto-desactivación | M | pendiente |
| HANDOFF-RACE-01 | Reclamar vencidos de forma atómica | L | pendiente |
| QUEUE-CLAIM-01 | Claim antes del I/O en los workers | L | pendiente |
| PROP-ASSIGN-DEC-01 | Decisión de negocio: asignación por propiedad | S + decisión | esperando definición |
| F1-API | Endpoints faltantes de analíticas | L | parcial |
| F4-API | Configuración de Sofía por tenant | L | pendiente |
| F5-API | Plantillas de Meta y mensajería saliente | L | pendiente |
| F7-API | Logs de Resend y envío de correo desde el CRM | L | pendiente |
| F8-API | Múltiples números de WhatsApp por tenant | XL | diferido |

---

## HANDOFF-EXHAUST-01 — ronda agotada sin cierre operativo

**Qué es.** En `procesarVencidos()` (`src/modules/agent/service.ts`), cuando
`elegirVendedor()` devuelve `null` porque todos los vendedores ya tuvieron ese
lead, el código **igual cierra el handoff** como `timeout_reasignado`. La
conversación queda en `esperando_humano`, el lead pegado al último vendedor, sin
handoff pendiente, sin próximo responsable y sin alerta a nadie. El cron solo
informa `sin_vendedores_disponibles` en su respuesta, que nadie lee.

**Ventaja.** Es el único estado del flujo en el que un lead real puede quedar sin
dueño y sin que nadie se entere. Hoy, con 2–3 vendedores activos, se alcanza en
pocas horas. Además el síntoma es indistinguible de "la reasignación no
funciona", así que cuesta soporte cada vez que pasa.

**Viabilidad.** M. No requiere migración si se resuelve dejando el handoff
pendiente (no cerrarlo) y sumando un aviso; requiere migración solo si se
decide un estado nuevo tipo `sin_responsable`. Hay que definir a quién escala
(admins del tenant) y evitar que el cron mande el mismo aviso cada 5 minutos.

**Estado.** Pendiente. **Pasó a prioritario el 2026-09-27**, cuando se publicó
el cron de vencidos en n8n: hasta entonces el caso no se alcanzaba nunca porque
ningún handoff vencía.

## LEAD-WEB-HANDOFF-01 — los leads del formulario web no tienen timeout

**Qué es.** `createPublicLead()` asigna por round-robin (o al dueño de la
propiedad) y manda el mail, pero **no crea handoff**. Sin handoff no hay
cronómetro, así que un lead web que nadie atiende nunca se reasigna.

**Ventaja.** Paridad real entre canales: hoy una consulta de WhatsApp que nadie
toma rebota al siguiente vendedor y una de la web se queda quieta para siempre.
Es la diferencia entre "el sistema garantiza atención" y "el sistema garantiza
atención solo por WhatsApp".

**Viabilidad.** L, con bloqueos conocidos que hay que resolver primero:
`handoffs.conversation_id` es NOT NULL y `handoffs_select` cuelga de
`conversations` (hay que colgarlo de `lead_id`); las policies
`vendedores_agente_*` no contemplan `is_auth_ctx()`, que es el contexto de
`createPublicLead`; y `procesarVencidos()` razona sobre la conversación, hay que
generalizarlo para que la señal de "tomado" pueda ser del lead. Plan completo
aprobado el 2026-08-24 en `Documents/Claude/Projects/Inmobiliaria lamelas/plan-reparto-leads-y-leidos.md`.

**Estado.** Pendiente. Contraparte de panel (estado "sin leer") en
`lamelas/docs/features.md` → `SIN-LEER-01`.

## CLASIF-PROPIETARIO-01 — clasificar al que viene a dejar una propiedad

**Qué es.** Pedido de los empleados de la inmobiliaria: poder clasificar al lead
como "propietario". Hoy `lead_clasificacion` es un enum de Postgres con dos
valores (`potencial`, `fantasma`).

**Ventaja.** Separar dos preguntas distintas que hoy se mezclan: *cuánto vale
este lead* (potencial/fantasma) y *qué vino a hacer* (comprar, alquilar, dejar su
propiedad). Con eso se puede medir cuánta captación entra por Sofía, que hoy es
invisible en las métricas.

**Viabilidad.** Dos caminos, y el barato es mejor:
- **S — exponer el dato que ya existe.** El prompt de Sofía ya detecta al
  propietario y deriva con `motivo: "tasacion"`, que queda guardado en
  `derivaciones.motivo`. Solo falta devolverlo en el lead y permitir filtrar por
  él. Sin migración.
- **M — agregar el valor al enum.** `alter type lead_clasificacion add value
  'propietario'` + zod en `crm/routes.ts` (2 lugares), `analytics/routes.ts`,
  `agent/resumen.ts` y los tipos de `crm/service.ts`. Ojo: hay que excluir
  `propietario` del auto-marcado como `fantasma` por silencio
  (`agent/service.ts`), que hoy pisaría la etiqueta.

**Estado.** Pendiente de decidir cuál de los dos. Contraparte de panel en
`lamelas/docs/features.md` → `MOTIVO-VISIBLE-01`.

## ZONA-NORMALIZE-01 — normalizar los valores de zona

**Qué es.** `properties.zona` es texto libre. El panel pasó a ofrecer una lista
cerrada de 22 zonas con escape "Otra" (`lamelas/docs/features.md` →
`ZONA-SELECT-01`), pero lo ya cargado quedó como estaba.

**Relevado en producción el 2026-09-28** (412 propiedades):

| Grupo | Filas | Valores distintos |
|---|---:|---:|
| Sin zona (`null` o vacío) | 73 | — |
| Ya con un valor exacto de la lista | 44 | — |
| Variantes tipográficas de la lista (`Barrio norte`, `B NORTE`, `Yerba buena`…) | 79 | 19 |
| Macro-zonas y cardinales (`Norte` 29, `Centro` 22, `Capital` 19, `Sur` 19, `Zona norte` 6, `Oeste` 5…) | 119 | 19 |
| Barrios reales que faltan en la lista + referencias que no son zona | 96 | 83 |

El dato importante: la lista de 22 zonas cubre **44 de las 339 propiedades que
tienen zona cargada**. El campo se usó como nota libre de ubicación, así que hay
direcciones y referencias (`Av Belgrano 3300`, `A 1 cuadra de Mate de Luna`,
`Ex hotel de la bancaria`, `Mercato Shopping viejo`, `265`) además de barrios.

**Ventaja.** Tres cosas dejan de estar mal a la vez: el filtro de zona del sitio
público (`select distinct zona` → hoy muestra decenas de opciones, muchas
duplicadas), el filtro "zona exacta" de analíticas (comparación exacta, parte los
conteos) y el caso especial de zona norte del buscador del agente, que exige
coincidencia exacta.

**Viabilidad.** Por fases, porque solo la primera es mecánica:
- **Fase 1 — variantes tipográficas (79 filas).** Script listo y revisable:
  [`bugfix/2026-09-28-zonas-fase1-variantes.sql`](./bugfix/2026-09-28-zonas-fase1-variantes.sql).
  Sin criterio comercial de por medio. Pendiente de aplicar.
- **Fase 2 — macro-zonas (119 filas).** Requiere decisión: `Norte`, `Centro`,
  `Capital`, `Sur`, `Oeste` no son barrios, son áreas. No hay mapeo mecánico
  posible; 119 filas es un patrón de uso, no un error de tipeo. Lo más probable es
  que convenga aceptarlas como valores válidos de la lista en vez de forzarlas a
  un barrio.
- **Fase 3 — ampliar `ZONAS` (96 filas).** Barrios reales que faltan y aparecen
  con volumen: Los Nogales (6), El Manantial (5, sumando `Manantial`,
  `El manantial`, `Manantial Sur`), Raco (3), Villa Urquiza (2), Barrio América
  (2), Alto Verde (2), Tafí del Valle (2), Barrio Floresta (2), y una cola larga
  de uno solo. Las referencias que no son zona no se normalizan: van a dirección o
  a notas, o se quedan como "Otra".

**Estado.** Fase 1 lista para aplicar; fases 2 y 3 esperando decisión.

## ZONA-ALIAS-01 — alias de zona norte con un typo

**Qué es.** `NORTH_ZONE_ALIASES = ["barrio norte", "norte", "zon norte"]` en
`src/modules/agent/property-search.ts`. `"zon norte"` parece un typo de
`"zona norte"`. Cuando un lead de San Miguel de Tucumán pide "zona norte", el
texto no entra en la lista de alias y cae al `like %zona norte%`, que no matchea
ninguna propiedad porque ninguna zona contiene literalmente esa cadena.

**Ventaja.** "Zona norte" es una de las formas más comunes de pedir la zona en
Tucumán, y hoy devuelve cero resultados. Arreglarlo es una línea.

**Viabilidad.** S. Revisar con los tests de `agent-search.test.ts` y confirmar si
el typo era intencional (podría haber sido para cubrir un valor real cargado en
la base).

**Estado.** Pendiente.

## EVENT-CATALOG-01 — `lead.assigned` no es suscribible

**Qué es.** `emitEvent()` lo acepta y `asignar()` lo emite, pero
`EVENTOS_VALIDOS` (`src/modules/webhooks/service.ts`) no lo incluye, y el schema
de `webhooks/routes.ts` se construye desde ese catálogo. Verificado el
2026-09-27: sigue faltando.

**Ventaja.** El evento ya viaja internamente; publicarlo habilita que n8n u otro
consumidor reaccione a una asignación (avisar por WhatsApp al vendedor, por
ejemplo) sin hacer polling. Es el habilitador de `NOTIF-REASIGNACION-01` del
repo del agente.

**Viabilidad.** S. Agregar el valor al catálogo y cubrir el delivery con un test.

**Estado.** Pendiente.

## HANDOFF-IDEMP-01 — handoffs pendientes duplicables

**Qué es.** `derivar()` → `asignar()` → `insertHandoff()` sin restricción única
de "un pendiente por conversación" (verificado: el modelo `Handoff` no tiene
`@@unique` para eso). `handoffPendienteDe()` devuelve solo uno de los posibles.

**Ventaja.** Evita estados contradictorios: dos derivaciones seguidas pueden
dejar dos vendedores creyendo que la consulta es suya, y el cron de vencidos
razonando sobre el handoff equivocado.

**Viabilidad.** M. Índice único parcial (`where resultado = 'pendiente'`) +
manejo del conflicto en el service. La migración puede fallar si ya hay
duplicados en producción: hay que limpiarlos antes.

**Estado.** Pendiente.

## WEBHOOK-HYGIENE-01 — políticas documentadas sin implementación

**Qué es.** `processDeliveriesOnce()` reintenta y marca `fallida`, pero no
desactiva endpoints con fallas consecutivas ni hay retención de deliveries
(verificado el 2026-09-27: no existe código de desactivación ni de retención).

**Ventaja.** Dejar de prometer en la documentación algo que no ocurre, y evitar
que la tabla de deliveries crezca sin techo.

**Viabilidad.** M. Necesita configuración, persistencia del contador y tests.
Alternativa válida y más barata: retirar la promesa de la documentación y dejar
solo la retención.

**Estado.** Pendiente.

## HANDOFF-RACE-01 — el cron de vencidos no reclama las filas

**Qué es.** `procesarVencidos()` trae el lote con `handoffsPendientes()` y
después lo recorre, sin reclamar cada fila antes de decidir. `elegirVendedor()`
usa `FOR UPDATE SKIP LOCKED`, pero eso protege el turno del vendedor, no el
handoff.

**Ventaja.** Hoy hay un solo cron cada 5 minutos, así que el riesgo es bajo. Pasa
a importar si se agrega una réplica del backend, un segundo workflow o alguien
dispara el endpoint a mano mientras el cron corre: la misma consulta se
reasignaría dos veces y saldrían dos mails.

**Viabilidad.** L. Claim transaccional por fila + tests de concurrencia.

**Estado.** Pendiente. Riesgo real bajo mientras el cron sea único.

## QUEUE-CLAIM-01 — workers con entrega duplicable

**Qué es.** `processDeliveriesOnce()` y `processChannelEventsOnce()` leen
pendientes y los marcan **después** del I/O, y los `startWebhookWorker()` /
`startZernioEventsWorker()` usan `setInterval()` sin esperar la pasada anterior.

**Ventaja.** Con una respuesta lenta, dos intervalos superpuestos o varias
réplicas, el mismo registro se despacha en paralelo (mensajes de WhatsApp
duplicados, en el peor caso).

**Viabilidad.** L. Claim/lease transaccional antes del I/O y tests de
concurrencia.

**Estado.** Pendiente.

## PROP-ASSIGN-DEC-01 — asignación por propiedad (decisión pendiente)

**Qué es.** `createPublicLead()` asigna las consultas con propiedad a
`property.userId` sin pasar por `syncActiveSellers()`/`chooseSeller()` y sin
validar que ese usuario siga activo y con rol agente.

**Ventaja.** Hoy una consulta puede caer en un vendedor dado de baja y quedar sin
atención, y el captador acumula carga sin que el round-robin lo compense.

**Viabilidad.** S una vez tomada la decisión de negocio: ¿el captador conserva
siempre la consulta? ¿qué fallback corre si no está activo? Después, pruebas
multi-tenant. Relacionado: `marcarAsignado` usa `update` (P2025 si la fila no
existe) y el dueño puede ser admin, que no está en `vendedores_agente` → pasar a
`updateMany`.

**Estado.** Esperando definición con la inmobiliaria.

## F1-API — endpoints faltantes de analíticas

**Qué es.** La primera entrega (resumen, consultas y ranking de propiedades por
consultas) está implementada. Faltan las vistas de vendedores y de Sofía, y más
adelante historial de eventos, resultados de conversaciones y consumo de modelos.

**Ventaja.** Es lo que convierte al panel en una herramienta de gestión: sin
métricas por vendedor no hay forma de discutir tiempos de respuesta con el
equipo.

**Viabilidad.** L, pero incremental: cada vista es un endpoint independiente.
Diseño en `lamelas-agent/docs/analytics-module.md`.

**Estado.** Parcial.

## F4-API — configuración de Sofía por tenant

**Qué es.** Tabla por tenant + endpoints con RLS + auditoría para: bot
activo/inactivo, horario y días de atención, `HANDOFF_TIMEOUT_MIN`, mensaje fuera
de horario, criterios comerciales, URL del sitio y disponibilidad de vendedores.

**Ventaja.** Saca de variables de entorno globales cosas que cada inmobiliaria
necesita distintas, y deja de requerir un deploy para cambiar un horario. El
timeout de handoff es el caso más concreto: hoy son 60 minutos hábiles para todos
y solo se cambia con una env var.

**Viabilidad.** L. El prompt, las tools y el modelo siguen siendo artefactos
versionados; editarlos en caliente queda fuera de alcance.

**Estado.** Pendiente. Pantalla en `lamelas/docs/features.md` → `F4-PANEL`.

## F5-API — plantillas de Meta y mensajería saliente

**Qué es.** Inventario de plantillas aprobadas, variables tipadas, envío desde un
lead con permisos, registro de envío y estado, control de la ventana de 24 horas
y límites anti-duplicado.

**Ventaja.** Permite que la inmobiliaria inicie la conversación (recordar una
visita, avisar una baja de precio) sin salirse de las reglas de WhatsApp.

**Viabilidad.** L y dependiente de terceros: requiere plantillas aprobadas por
Meta y que Zernio informe estado de entrega. Campañas masivas fuera de alcance.

**Estado.** Pendiente.

## F7-API — logs de Resend y correo desde el CRM

**Qué es.** (1) Vista de logs de entrega/rebote/error filtrada por tenant.
(2) Envío de correo desde el lead con destinatario validado, plantillas,
permisos, auditoría y prevención de duplicados.

**Ventaja.** Hoy, cuando un vendedor dice "no me llegó el aviso", no hay forma de
verificarlo desde el sistema. Y toda la comunicación por mail con el cliente pasa
por fuera del CRM, así que no queda registrada.

**Viabilidad.** L. Evaluar usar la API de Resend además del SMTP actual; la API
key queda solo en backend.

**Estado.** Pendiente.

## F8-API — múltiples números de WhatsApp por tenant

**Qué es.** Hoy se admite una sola cuenta de WhatsApp activa por tenant. Amplía:
varias `channel_accounts` activas, selección del número al enviar, routing por
`channel_account_id`, configuración por número, permisos por equipo, métricas
separadas y alta/baja sin afectar las otras cuentas.

**Ventaja.** Es el requisito para vender el sistema a una inmobiliaria con
sucursales o para separar ventas de alquileres.

**Viabilidad.** XL. Diferida hasta que Coexistence del número actual esté estable
y haya observabilidad y métricas.

**Estado.** Diferido.
