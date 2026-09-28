# Plan de adopción: WhatsApp Coexistence ya conectado en Zernio

**Fecha:** 2026-08-27  
**Estado histórico:** la adopción y la identidad por cuenta/conversación están implementadas en código; el estado operativo del número debe verificarse fuera del repositorio
**Escenario real:** el número productivo del cliente ya fue conectado en Zernio
mediante WhatsApp Business App Coexistence. No se debe repetir el onboarding,
migrar el número ni desconectarlo para incorporar el sistema de Koi.  
**Repos involucrados:** `back-lamelas`, `lamelas-agent` y `lamelas`.

## 1. Objetivo y prioridad

Adoptar de forma segura la cuenta Coexistence existente para que:

- aparezca en el panel como el número activo del tenant correcto;
- los webhooks entrantes despierten a Sofi y creen la conversación correcta;
- cada conversación conserve la cuenta y la conversación de Zernio de origen;
- una respuesta desde WhatsApp Business detenga a Sofi;
- el panel represente Coexistence y no ofrezca una desconexión engañosa;
- ninguna carrera permita que Sofi responda después de una intervención humana.

La prioridad no es habilitar múltiples números ni plantillas. Primero se debe
estabilizar el único número productivo ya conectado.

### 1.1 Estado operativo inmediato

La conexión realizada directamente en Zernio no crea automáticamente el mapeo
local de Koi. Hasta que el nuevo `accountId` exista como una fila activa de
`channel_accounts`:

- el panel no podrá representar esa cuenta como conectada;
- el worker no podrá resolver `accountId -> tenant_id`;
- los eventos pueden ingresar y quedar en error como cuenta desconocida;
- Sofi no debe considerarse operativa para ese número.

La primera acción no es volver a conectar el teléfono. Es ejecutar B0 para
confirmar profile, account y webhook, y luego B1/B2 para adoptar esa cuenta de
forma validada e idempotente.

## 2. Reglas de seguridad para esta adopción

1. **No volver a ejecutar Embedded Signup sobre el número productivo.** El botón
   actual genera `onboarding=api`, mientras la cuenta real ya está conectada por
   `business_app`.
2. **No borrar la cuenta de Zernio.** El `DELETE /accounts/:id` actual no debe
   usarse como mecanismo de desconexión de Coexistence.
3. **No insertar IDs productivos en una migración.** La vinculación del
   `profileId`/`accountId` es configuración operativa, no estructura de BD.
4. **No confiar en IDs enviados por el navegador.** El backend debe comprobar
   contra Zernio que la cuenta existe, está activa, es WhatsApp y pertenece al
   profile que se está vinculando.
5. **Mantener un solo WhatsApp activo por tenant** durante esta entrega.
6. **Hasta completar la toma automática**, el equipo debe tomar el chat en el
   panel antes de responder desde WhatsApp Business.

## 3. Estado encontrado en cada proyecto

### 3.1 `back-lamelas`

Ya existe:

- profile de Zernio por tenant (`tenants.zernio_profile_id`);
- `channel_accounts` con `zernio_account_id` único;
- callback que consulta las cuentas reales del profile;
- webhook HMAC `POST /webhooks/zernio`;
- cola idempotente `channel_webhook_events`;
- worker que resuelve `accountId -> tenant` y agrupa `message.received`;
- disparo del workflow configurado en `N8N_WHATSAPP_WEBHOOK_URL`;
- health individual por cuenta.

Brechas:

- no hay una operación explícita y auditable para adoptar una cuenta ya
  conectada fuera del panel;
- `channel_accounts` no registra el modo `coexistence`;
- las conversaciones no guardan `channel_account_id` ni
  `provider_conversation_id`;
- el buffer agrupa sólo por `conversationId`, no por cuenta;
- `message.sent` y `account.disconnected` se marcan procesados sin actuar;
- el envío de Sofi no pasa por una autorización final del backend;
- la policy del worker sobre `channel_accounts` es sólo de lectura.

### 3.2 `lamelas-agent`

El workflow objetivo es `n8n/lamelas-agente-zernio.json`. El archivo
`n8n/lamelas-agente.json` es el flujo legado de Kapso y no se debe modificar ni
activar como parte de esta adopción.

El workflow de Zernio:

- recibe una ráfaga con `data[]`, abre/reutiliza la conversación y registra el
  mensaje;
- corta si `bot_activo` es falso;
- consulta contexto, ejecuta Sofi, parte la respuesta y registra la salida;
- ya normaliza el payload de Zernio y conserva `account_id` y
  `conversation_id` durante la ejecución;
- envía directamente a `zernio.com/api/v1`, fuera de una política de envío del
  backend;
- todavía no recibe ni persiste el `channel_account_id` local y no procesa
  `message.source` para detectar una intervención desde WhatsApp Business;
- verifica `bot_activo` antes de generar, pero no inmediatamente y de forma
  atómica antes de cada envío.

Además, varios documentos del agente todavía describen WhatsApp Trigger/Cloud
API o dicen que Zernio no fue elegido. Deben actualizarse para no operar con
dos arquitecturas contradictorias.

### 3.3 `lamelas`

Ya existe:

- pantalla admin `/whatsapp/conectar`;
- Server Actions que hablan sólo con `back-lamelas`;
- callback que propaga `accountId` y deja al backend verificarlo;
- listado, health y desconexión.

Brechas:

- el botón inicia `onboarding=api`, incorrecto para futuras reconexiones
  Coexistence;
- no existe UI para adoptar una conexión ya existente;
- no se muestra el modo de conexión;
- el diálogo de desconexión promete una baja que no representa el flujo real de
  Coexistence;
- no se muestra “Atendido desde WhatsApp Business”.

## 4. Decisión de arquitectura

### 4.1 Adopción inicial mediante operación de servidor

Para este cliente se implementará una operación administrativa ejecutada desde
el servidor, no desde el navegador:

```text
npm run zernio-adopt -- \
  --tenant <tenant-slug> \
  --profile <zernio-profile-id> \
  --account <zernio-account-id> \
  --mode coexistence
```

Sin `--apply` el comando siempre es un dry-run: consulta Zernio y la base, pero
no escribe. Para aplicar una adopción que cambia el profile canónico se repite
el mismo comando agregando:

```text
--apply \
--replace-profile <profile-id-actual> \
--confirm <tenant-slug>:<ultimos-8-del-account-id>
```

La frase exacta se imprime al final del dry-run. El reemplazo y la adopción se
hacen en una única transacción; si el tenant/profile/cuenta activa cambian
entre la simulación y la escritura, la operación aborta.

Este entrypoint se compila como `dist/ops/zernio-adopt.js` y está disponible en
la terminal del contenedor de producción. No abre una ruta HTTP. En desarrollo
también se puede invocar desde la CLI general con
`npm run admin -- zernio-adopt ...`.

El nombre final puede adaptarse a la CLI existente, pero debe cumplir este
contrato:

1. resolver el tenant por slug;
2. consultar `/profiles` y `/accounts` usando `ZERNIO_API_KEY`;
3. comprobar que `accountId` pertenece a `profileId`, es WhatsApp y está activo;
4. rechazar si el account ya pertenece a otro tenant;
5. rechazar si el tenant ya tiene otro WhatsApp activo;
6. si el tenant no tiene `zernio_profile_id`, guardarlo sólo después de
   validar;
7. si el tenant ya tiene otro `zernio_profile_id`, abortar sin modificarlo y
   explicar que primero se debe mover la cuenta en Zernio al profile canónico o
   ejecutar una operación explícita de reemplazo después de auditar el profile
   anterior;
8. crear o reactivar `channel_accounts` con `connection_mode=coexistence`;
9. guardar snapshot de número/nombre;
10. emitir sólo IDs parciales y resultado en logs, nunca secrets.

Esta operación evita reabrir Meta y deja un procedimiento repetible y
auditable. No se debe resolver mediante SQL manual ni modificando una migración.

### 4.2 Conexiones futuras

Después de estabilizar la adopción, el flujo del panel para WhatsApp debe pedir
explícitamente:

```text
onboarding=business_app
```

El backend seguirá verificando el `accountId` contra las cuentas del profile.
Mientras se soporte un solo número, el callback puede aceptar la ausencia del
ID sólo si encuentra exactamente una cuenta WhatsApp activa; con cero o más de
una debe devolver conflicto y no elegir “la primera”.

### 4.3 Identidad de conversación

Para WhatsApp, la identidad será:

```text
tenant_id + channel_account_id + provider_conversation_id
```

Si un payload real no trae `conversationId`, el fallback será:

```text
tenant_id + channel_account_id + canal_ref
```

La identidad web conserva `(tenant_id, canal, canal_ref)`. Los índices deben
ser parciales por canal para no volver obligatorio `channel_account_id` en web.

### 4.4 Garantía antes del envío

n8n no debe ser quien garantice que Sofi todavía puede responder. Un patrón de
“consultar estado y después enviar” tiene una carrera entre ambas acciones.

Se agregará una operación de backend para despachar una respuesta de Sofi. Esa
operación debe:

1. recibir `conversation_id`, contenido e idempotency key;
2. ejecutar bajo tenant-context del API key;
3. verificar dentro de transacción que `estado='bot'`;
4. resolver `channel_account_id` y `provider_conversation_id`;
5. registrar un envío pendiente/idempotente;
6. hacer el POST externo desde un worker;
7. actualizar el mensaje con el ID/resultado del proveedor.

Si la conversación ya es humana, debe cancelar sin enviar. n8n no volverá a
llamar directamente al endpoint del proveedor.

## 5. Cambios en `back-lamelas`

### B0 — Caracterización de la cuenta productiva

- Guardar fixtures sanitizados de eventos reales:
  `message.received`, `message.sent` desde WhatsApp Business,
  `message.sent` desde Cloud API y `account.disconnected`.
- Confirmar paths y valores exactos de `accountId`, `conversationId`, teléfono,
  texto, message ID y `message.source`.
- Confirmar en Zernio que el webhook productivo apunta a
  `https://api.inmobiliarialyc.com.ar/webhooks/zernio`, está activo, usa el
  mismo secret del VPS y registra respuestas HTTP 200.

No se programa contra payloads supuestos antes de este checkpoint.

### B1 — Migración de identidad y modo

Crear una migración nueva con:

- `channel_accounts.connection_mode`:
  `coexistence | cloud_api | unknown`, default `unknown`;
- `channel_accounts.disconnected_at` nullable;
- `conversations.channel_account_id` FK nullable;
- `conversations.provider_conversation_id` nullable;
- `leads.tomado_origen` nullable:
  `panel | whatsapp_business_app | sistema`;
- estructura idempotente para envíos salientes y estado del proveedor.

Agregar índices parciales:

- conversación WhatsApp viva por cuenta + `provider_conversation_id`;
- fallback WhatsApp vivo por cuenta + `canal_ref` cuando no hay ID proveedor;
- conservar la unicidad viva actual para `canal='web'`.

Mantener el índice de un WhatsApp activo por tenant. Actualizar Prisma,
`diagrama-er.md`, `permisos-rls.md` y `api-spec.md`.

### B2 — CLI de adopción

- Extender `scripts/admin-cli.ts` con `zernio-adopt`.
- Reusar el cliente `lib/zernio.ts`.
- Implementar la escritura por repositorio/service o por una función operativa
  que preserve las mismas validaciones; no duplicar reglas en el parser CLI.
- Permitir reejecución idempotente sobre la misma cuenta.
- Rechazar por defecto un `profileId` diferente del ya guardado en el tenant;
  no sobrescribirlo silenciosamente. La escritura exige `--replace-profile`
  con el valor actual y una confirmación ligada al tenant/account.
- Hacer dry-run por defecto y exigir `--apply` para cualquier escritura.
- Validar también `/accounts/:id/health` antes de abrir la transacción.
- Agregar tests de cuenta ajena, cuenta inactiva, profile incorrecto, segundo
  WhatsApp activo y reconexión de la misma cuenta.

Checkpoint: la cuenta productiva aparece en `GET /v1/integrations/channels` sin
haber repetido el onboarding.

### B3 — Propagar identidad al agente

**Implementada el 28/08/2026.** El envelope, el endpoint y las conversaciones
persisten cuenta y conversación de Zernio; los chats legados adoptan la
identidad en su primer evento posterior al despliegue.

- Cambiar la clave del buffer a `accountId + conversationId`.
- Hacer que `findTenantByZernioAccountId` devuelva también el ID local de
  `channel_accounts`.
- Enviar a n8n un envelope explícito:

```json
{
  "tenant_id": "uuid",
  "canal": "whatsapp",
  "channel_account_id": "uuid",
  "zernio_account_id": "account-id",
  "provider_conversation_id": "conversation-id",
  "data": []
}
```

- Extender `POST /v1/agent/conversations` con campos opcionales para no romper
  `/v1`; exigirlos condicionalmente para entradas WhatsApp nuevas disparadas
  por Zernio.
- Buscar/crear la conversación con la identidad definida en §4.3.
- Persistir IDs del mensaje proveedor en `conversation_messages.meta` o en
  columnas específicas del modelo de salida.

### B4 — Intervención desde WhatsApp Business

**Implementada el 28/08/2026.** Los mensajes de la app se deduplican por ID del
proveedor, se registran como vendedor y pasan el chat a humano sin inventar
`tomado_por`. Las salidas `cloud_api` no despiertan ni toman el agente. El
workflow vuelve a consultar `bot_activo` inmediatamente antes de enviar; la
centralización atómica completa del despacho sigue perteneciendo a B5.

Procesar `message.sent` de forma idempotente:

- `source=cloud_api`: actualizar el envío correspondiente; no tomar el chat;
- `source=whatsapp_business_app`:
  - localizar por cuenta + conversación proveedor;
  - registrar mensaje con `rol=vendedor` y origen externo;
  - cambiar conversación a `humano`;
  - cerrar el handoff pendiente si existe;
  - establecer `lead.tomado_at` y
    `lead.tomado_origen=whatsapp_business_app`;
  - conservar `tomado_por=null` si no se conoce la persona física.

La transición, el mensaje y la toma deben ocurrir en una transacción. Agregar
policy RLS específica para la operación del worker y pruebas con dos tenants.

### B5 — Envío centralizado y anti-carrera

- Agregar endpoint de despacho del agente bajo `agent:write`.
- Implementar idempotencia y cola/outbox de salida.
- Resolver account/conversation del proveedor sólo desde la BD.
- Rechazar si el chat no está en `bot`.
- Procesar `message.sent`, `message.delivered`, `message.read` y
  `message.failed` para cerrar el ciclo.
- No marcar una cuenta como desconectada por un fallo de pago o plantilla.

### B6 — Desconexión y health

- Procesar `account.disconnected` por `accountId`.
- Marcar sólo esa cuenta y poner sus conversaciones vivas en `humano`.
- Registrar `disconnected_at`.
- Para Coexistence, no ejecutar `DELETE` desde el panel.
- Agregar reconciliación de health e indicar `requiere_accion` sin confundirlo
  con una desconexión confirmada.

## 6. Cambios en `lamelas-agent`

### A1 — Congelar evidencia y delimitar el workflow productivo

- Exportar y respaldar `lamelas-agente-zernio` desde n8n antes de editarlo y
  compararlo con `n8n/lamelas-agente-zernio.json`.
- Crear fixture sanitizado del envelope real enviado por el backend.
- Mantener `Webhook Zernio` como trigger del flujo productivo.
- Marcar `n8n/lamelas-agente.json` y sus referencias a Kapso como legado; no
  importarlo ni activarlo durante esta entrega.
- Eliminar documentación que diga que WhatsApp entra por el Trigger nativo de
  Meta si ya no representa producción.

### A2 — Normalización con identidad completa

El nodo `normalizar` debe producir, como mínimo:

```json
{
  "canal": "whatsapp",
  "channel_account_id": "uuid",
  "zernio_account_id": "account-id",
  "provider_conversation_id": "conversation-id",
  "contact_ref": "+549...",
  "sender": "+549...",
  "source": "...",
  "provider_message_id": "...",
  "concat_message": "..."
}
```

`abrir_conversacion` debe enviar esas referencias al backend. El registro del
mensaje debe conservar `provider_message_id`, source y media metadata.

### A3 — Medios

- Validar con un payload real si descarga de audio/imagen conserva los endpoints
  actuales.
- Resolver media usando la cuenta Zernio correcta cuando la API lo requiera.
- Probar texto, audio, imagen y ráfaga mixta.

### A4 — Reemplazar envío directo

- Retirar del workflow Zernio el nodo `Send message` que llama directamente a
  `https://zernio.com/api/v1/inbox/conversations/.../messages`.
- Por cada fragmento, llamar al endpoint de despacho de `back-lamelas` con una
  idempotency key derivada de ejecución + conversación + posición.
- Tratar `conversation_not_bot` como cancelación exitosa, no como retry.
- Registrar la salida desde el resultado del backend; no asumir que un POST
  externo fue aceptado.
- Antes de partir/enviar, conservar el check temprano `bot_activo` para ahorrar
  costo de OpenAI; la garantía final seguirá en el backend.

### A5 — Contratos y validación

- Actualizar `docs/contrato-agente-api.md`.
- Actualizar `docs/arquitectura-agente.md`, `docs/plataformas-whatsapp.md`,
  `docs/plan-implementacion-zernio.md` y `docs/migracion-zernio.md` con la
  arquitectura realmente desplegada.
- Actualizar `agent-contract/verificar-n8n.mjs` para exigir las referencias de
  cuenta/conversación y prohibir URLs directas de envío a Kapso/Zernio.
- Generar el JSON de n8n desde fuentes versionadas cuando corresponda y validar
  importación en un workflow de staging antes de activar producción.

## 7. Cambios en `lamelas`

### P1 — Representar Coexistence

- Extender `ChannelAccount` y la adaptación de `queries.ts` con
  `connection_mode`, health y fechas de desconexión.
- Mostrar badge “Coexistence” y texto: “WhatsApp Business sigue activo”.
- Mostrar número y nombre verificados por el backend.
- La página sigue siendo Server Component; las mutaciones continúan en Server
  Actions. Ningún ID o credencial de Zernio se expone como autorización.

### P2 — Flujo de conexión futuro

- Cambiar el backend a `onboarding=business_app`; el panel sólo consume la URL
  resultante.
- Mantener callback server-side y propagación de `accountId`.
- Eliminar la recuperación que completa sin `accountId`, o permitirla sólo
  cuando el backend confirma exactamente una cuenta activa.
- No agregar un formulario público de `profileId/accountId`; la adopción
  productiva inicial se hace con la CLI del servidor.

### P3 — Desconexión segura

Para `connection_mode=coexistence`:

- reemplazar “Desconectar” por instrucciones para hacerlo desde WhatsApp
  Business;
- agregar “Verificar desconexión”;
- advertir que Sofi se detendrá al confirmarse el evento/health;
- no llamar al `DELETE` actual.

Para otros modos sólo mostrar la acción que el backend declare soportada.

### P4 — Toma desde la aplicación

- Mostrar `tomado_origen` en el lead/conversación.
- Si es `whatsapp_business_app`, mostrar “Atendido desde WhatsApp Business”.
- No inventar avatar, vendedor ni `tomado_por`.
- Refrescar la vista al recibir/pollear el cambio de estado según el mecanismo
  existente; realtime queda fuera de alcance si no existe actualmente.

### P5 — Estado operativo

- Distinguir: conectado, requiere acción, desconectado y error de envío.
- No interpretar pago/plantilla fallida como canal desconectado.
- Mantener mensajes de error en español (AR) y diseño mobile-first.

## 8. Orden de implementación y despliegue

### Entrega 0 — Incorporación sin tocar el número

1. B0: capturar IDs/payloads y verificar webhook.
2. B1: migración compatible y deploy.
3. B2: CLI de adopción.
4. Ejecutar la adopción productiva.
5. P1: mostrar el modo correcto.
6. Smoke test de entrada y respuesta actual.

Resultado: el número aparece y Sofi funciona, pero la operación mantiene la
regla temporal de tomar el chat en el panel antes de responder desde la app.

### Entrega 1 — Coexistence segura

1. B3 + A2/A3: identidad completa de entrada.
2. B4 + P4: respuesta desde WhatsApp Business toma el chat.
3. B5 + A4: autorización final y envío centralizado.
4. B6 + P3/P5: desconexión y estados operativos.
5. Observar producción al menos 48 horas.

### Entrega 2 — Recién después

- múltiples números;
- plantillas y mensajes fuera de ventana;
- costos/presupuestos;
- campañas o automatizaciones comerciales.

## 9. Matriz mínima de pruebas

### Adopción

- profile/account correcto crea una fila activa Coexistence;
- reejecutar no duplica;
- account ajeno, inactivo o de otro profile se rechaza;
- otro tenant no puede ver ni reclamar la cuenta;
- no se abre Meta ni se desconecta WhatsApp Business.

### Entrada

- texto crea/reutiliza conversación con cuenta y conversation ID;
- audio, imagen y ráfaga mixta mantienen identidad;
- dos cuentas con el mismo `conversationId` no comparten buffer;
- el mismo contacto en dos cuentas no comparte conversación;
- web sigue funcionando sin `channel_account_id`.

### Intervención humana

- `whatsapp_business_app` registra mensaje, toma lead y pone chat humano;
- `cloud_api` no toma el chat;
- evento repetido no duplica mensaje ni toma;
- no se atribuye un usuario inexistente;
- un tenant no modifica conversaciones de otro.

### Carrera y salida

- Sofi genera mientras el chat está en bot, una persona responde y el despacho
  posterior se cancela;
- retry/doble clic produce un solo envío;
- cada fragmento conserva orden e idempotencia;
- fallo externo no queda registrado como entregado;
- delivery/read/failed actualizan un solo mensaje.

### Panel

- muestra badge Coexistence y número correcto;
- no ofrece DELETE remoto para Coexistence;
- muestra toma desde WhatsApp Business sin vendedor inventado;
- estados y diálogos funcionan en viewport móvil.

## 10. Checklist operativo inmediato

Antes de implementar todo el plan, verificar hoy:

- [x] anotar `profileId` y `accountId` de la cuenta productiva;
- [x] confirmar que `ZERNIO_API_KEY` pertenece al mismo team;
- [x] confirmar webhook productivo activo y HTTP 200;
- [ ] confirmar `ZERNIO_WEBHOOK_SECRET` idéntico en Zernio y VPS;
- [ ] confirmar `N8N_WHATSAPP_WEBHOOK_URL` y workflow activo;
- [ ] no usar “Conectar WhatsApp” ni “Desconectar” sobre el número productivo;
- [ ] informar al equipo: tomar chat en el panel antes de responder desde la app;
- [ ] guardar fixtures sanitizados de los primeros eventos reales.

## 11. Definition of Done

### `back-lamelas`

```bash
npm run lint
npx tsc --noEmit
npm run build
npm test
```

Incluye suite RLS con dos tenants, migración nueva y actualización de OpenAPI y
documentos del contrato.

### `lamelas`

```bash
npm run lint
npx tsc --noEmit
npm run build
```

Además, prueba manual desktop/móvil del flujo admin y de la ficha de consulta.

### `lamelas-agent`

- workflow importable en n8n de staging;
- `agent-contract/verificar-n8n.mjs` en verde;
- replay de fixtures sanitizados;
- smoke test real app -> backend -> n8n -> Zernio;
- export final del workflow versionado antes de activar producción.

## 12. Rollback funcional

Si falla la automatización:

1. poner las conversaciones de esa cuenta en `humano`;
2. detener el workflow de Sofi o el dispatch sin borrar eventos;
3. conservar WhatsApp Business como canal operativo;
4. no desconectar el número ni borrar `channel_accounts`;
5. corregir y reproducir desde fixtures/eventos pendientes de forma
   idempotente.
