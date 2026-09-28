# WhatsApp: pagos de Meta, tarifas, plantillas y plan de implementación

**Fecha de referencia:** 2026-08-27  
**Estado:** análisis y planificación; no implementado  
**Alcance:** Meta WhatsApp Business Platform vía Zernio, `back-lamelas`,
`lamelas` y `lamelas-agent`

## 1. Resumen ejecutivo

WhatsApp tiene dos facturadores independientes:

1. **Meta** cobra a la WhatsApp Business Account (WABA) del cliente por los
   mensajes de plantilla entregados. El importe depende de la categoría y del
   país del destinatario.
2. **Zernio** cobra por su plataforma y, si se compra un número a Zernio, por
   ese número. Zernio declara que no agrega margen ni refactura el costo de los
   mensajes de Meta.

Para el caso de la inmobiliaria:

- el método de pago de Meta debe pertenecer al cliente y quedar asociado a su
  WABA;
- Coexistence no cambia las reglas de facturación;
- mientras el cliente inicia la conversación y Sofi responde dentro de la
  ventana vigente de 24 horas, el flujo actual utiliza texto libre;
- para iniciar una conversación o retomarla fuera de esa ventana se necesita
  normalmente una plantilla aprobada;
- hoy el sistema no administra plantillas, no decide entre texto y plantilla,
  no registra costos y no procesa el ciclo completo de entrega.

No alcanza con agregar una tarjeta en Meta. También hay que crear y aprobar las
plantillas y modificar el sistema para enviarlas de manera controlada.

## 2. Glosario

### WABA

La **WhatsApp Business Account** es el activo de Meta que contiene los números,
plantillas, método de pago, calidad y límites de mensajería del negocio. Las
plantillas pertenecen a la WABA, no al panel de Koi ni a n8n.

### Ventana de atención de 24 horas

Cada mensaje entrante del cliente abre o renueva una ventana móvil de 24 horas.
Durante esa ventana se pueden enviar respuestas de texto libre. Cuando vence,
Meta rechaza el texto libre y exige una plantilla aprobada para reabrir la
conversación.

### Plantilla

Una plantilla es un mensaje estructurado y previamente revisado por Meta. Tiene
un nombre estable, idioma, categoría, componentes y variables. Solo una
plantilla en estado `APPROVED` se puede usar en producción.

### Rate y rate limit

En este documento, **rate** significa tarifa monetaria por mensaje entregado.
No debe confundirse con el **rate limit**, que es la cantidad de solicitudes o
mensajes que la plataforma permite por unidad de tiempo.

## 3. Qué cobra Meta

### Unidad de cobro

Meta aplica precio **por mensaje de plantilla entregado**, no por conversación,
carácter ni ejecución del workflow. Un intento fallido o no entregado no debería
contabilizarse como una entrega facturable, aunque debe quedar registrado para
auditoría y reintentos.

La tarifa se determina principalmente por:

- categoría efectiva asignada por Meta;
- código de país del número destinatario, no ubicación del negocio;
- moneda configurada en la cuenta de facturación;
- descuentos por volumen que pudieran corresponder;
- impuestos, conversión y condiciones de la cuenta de Meta.

### Categorías

| Categoría | Uso | Ejemplo inmobiliario | Cobro |
|---|---|---|---|
| `MARKETING` | Promoción, captación o reactivación comercial | Nuevas propiedades que podrían interesarle | Por entrega |
| `UTILITY` | Continuación de una solicitud o transacción concreta | Recordatorio de una visita solicitada | Por entrega fuera de la ventana; actualmente gratuita dentro de la ventana según Zernio |
| `AUTHENTICATION` | Código de acceso o verificación | OTP para confirmar identidad | Por entrega |

Meta puede reclasificar una plantilla. El sistema debe utilizar la categoría
efectiva informada por Meta, no asumir que conserva la solicitada al crearla.

### Mensajes de servicio

A la fecha de este documento, Zernio documenta:

- texto libre dentro de la ventana de 24 horas: sin cargo de mensajería;
- plantilla `UTILITY` dentro de esa ventana: sin cargo;
- plantillas `MARKETING`, `UTILITY` fuera de ventana y `AUTHENTICATION`: cobro
  por entrega.

Las reglas y rate cards de Meta cambian con frecuencia. Antes de lanzar una
automatización o campaña se debe revisar la rate card vigente en WhatsApp
Manager. El sistema no debe codificar para siempre la gratuidad de una clase de
mensaje: debe tratarla como una regla configurable y fechada.

## 4. Rate de referencia para Argentina

La rate card pública reproducida para Argentina al 2026-08-27 informa estos
precios de lista en dólares estadounidenses por plantilla entregada:

| Categoría | USD por entrega | 1.000 entregas, sin descuentos ni impuestos |
|---|---:|---:|
| Marketing | USD 0,0618 | USD 61,80 |
| Utility | USD 0,0260 | USD 26,00 |
| Authentication | USD 0,0260 | USD 26,00 |
| Authentication International | No aplica | No aplica |
| Servicio dentro de ventana | USD 0,00 según regla vigente documentada por Zernio | USD 0,00 |

Estos valores son una **referencia operativa**, no una cotización contractual.
La fuente de verdad para facturación es la rate card que Meta muestra para la
WABA del cliente. Meta puede facturar en otra moneda soportada y aplicar
impuestos o descuentos. La estimación del panel debe mostrar fecha y moneda y
nunca prometer que será idéntica a la factura.

Ejemplo: enviar una plantilla de marketing a 2.500 números argentinos y lograr
2.000 entregas produciría un costo base estimado de:

```text
2.000 x USD 0,0618 = USD 123,60
```

El cálculo debe usar entregas, no destinatarios cargados ni intentos.

## 5. Quién paga y cómo se configura

### Meta

El cliente debe agregar su medio de pago a su WABA. Durante Embedded Signup
puede aparecer `Añadir método de pago`; también se puede hacer después desde
Meta Business Suite / WhatsApp Manager. Los nombres exactos del menú pueden
cambiar, pero siempre se debe verificar que:

1. se seleccionó el Business Portfolio correcto;
2. se seleccionó la WABA que contiene el número conectado;
3. la tarjeta pertenece al negocio o está autorizada por este;
4. el método figura activo y sin saldo vencido;
5. los administradores del cliente conservan acceso a facturación e invoices.

Koi no debería cargar una tarjeta propia en la WABA del cliente. Hacerlo mezcla
costos entre clientes, dificulta el corte del servicio y transfiere un riesgo
financiero innecesario.

### Zernio

Zernio tiene su propia facturación por cuentas conectadas y servicios. Un
número existente usado mediante Coexistence no es un número alquilado a Zernio,
pero sí constituye una cuenta conectada dentro del plan del team. Esta factura
es independiente de Meta.

### Qué ocurre si falla el método de pago

- Meta puede rechazar plantillas pagas aunque la conexión y el health de Zernio
  sigan funcionando.
- Los mensajes entrantes pueden continuar llegando.
- Las respuestas permitidas dentro de la ventana pueden seguir funcionando
  según las reglas vigentes.
- El sistema debe mostrar un error de facturación diferente de un error de
  conexión y no marcar el número como desconectado.

## 6. Qué es una plantilla

Una plantilla se identifica por la combinación de:

- `accountId` o WABA a la que pertenece;
- `name`, en formato técnico estable, por ejemplo `recordatorio_visita`;
- `language`, por ejemplo `es_AR` si está soportado por la plantilla;
- `category` efectiva;
- `components`.

### Componentes habituales

- `HEADER`: texto o medio opcional.
- `BODY`: contenido principal y variables `{{1}}`, `{{2}}`, etc.
- `FOOTER`: texto auxiliar sin información esencial.
- `BUTTONS`: respuestas rápidas, URL o llamada.

Las variables deben recibir ejemplos al crear la plantilla. En el envío, la
cantidad, orden y tipo de parámetros deben coincidir exactamente con la versión
aprobada.

### Estados

| Estado | Significado operativo |
|---|---|
| `PENDING` | Meta todavía la revisa |
| `APPROVED` | Disponible para enviar |
| `REJECTED` | Requiere corrección o apelación |
| `IN_APPEAL` | Revisión de una apelación |
| `PAUSED` | Meta la pausó por calidad u otra señal |
| `DISABLED` | No puede volver a enviarse en su estado actual |
| `PENDING_DELETION` | Eliminación solicitada |

La aprobación puede tardar hasta 24 horas según Zernio. Existe además una
biblioteca de plantillas preaprobadas que puede evitar la espera, siempre que
el caso de uso y sus botones coincidan.

## 7. Diseño recomendado de las primeras plantillas

### Recordatorio de visita (`UTILITY` propuesto)

```text
Hola {{1}}, te recordamos la visita a {{2}} programada para el {{3}} a las
{{4}}. Si necesitás reprogramarla, respondé este mensaje.
```

Debe existir una visita solicitada o acordada. No se debe agregar promoción de
otras propiedades, porque Meta podría reclasificarla como marketing.

### Seguimiento de consulta (`UTILITY` o `MARKETING` según contexto)

```text
Hola {{1}}, tenemos una actualización sobre la propiedad {{2}} por la que
consultaste. ¿Querés que te la enviemos?
```

Solo debería proponerse como utility cuando sea una actualización concreta de
una solicitud existente. Un seguimiento genérico para reactivar interés puede
ser considerado marketing.

### Propiedades sugeridas (`MARKETING`)

```text
Hola {{1}}, encontramos propiedades nuevas que coinciden con tu búsqueda en
{{2}}. Podés verlas acá: {{3}}. Respondé BAJA si no querés recibir novedades.
```

Requiere consentimiento comercial, control de frecuencia y baja efectiva.

### Reglas de contenido

- No mezclar información transaccional con promoción para intentar obtener una
  tarifa menor.
- Usar nombres e idiomas estables; una variante de idioma es una plantilla
  distinta.
- No insertar datos sensibles innecesarios.
- Validar URLs y parámetros antes del envío.
- Incorporar opt-out en marketing y respetarlo en todos los canales del tenant.

## 8. Cómo se configuran actualmente en Meta/Zernio

### Camino manual inicial recomendado

1. Conectar el número y confirmar la WABA.
2. Agregar el método de pago del cliente en Meta.
3. Abrir WhatsApp Manager o la sección de plantillas de Zernio.
4. Crear nombre, idioma, categoría y componentes.
5. Proporcionar ejemplos para cada variable.
6. Enviar a revisión.
7. Esperar `APPROVED`.
8. Verificar desde Zernio que la plantilla aparece para el `accountId` correcto.
9. Hacer un envío controlado a un número interno fuera de la ventana de 24
   horas.
10. Confirmar en Meta entrega, categoría y cargo.

### API de Zernio

Operaciones relevantes:

```text
GET  /v1/whatsapp/templates?accountId=...
POST /v1/whatsapp/templates
GET  /v1/whatsapp/template-library?accountId=...&name=...
POST /v1/inbox/conversations
POST /v1/inbox/conversations/{conversationId}/messages
```

Para una conversación inexistente se usa `POST /v1/inbox/conversations` con la
plantilla. Para una conversación existente pero fuera de ventana se envía la
plantilla al endpoint de mensajes. Zernio pasa los componentes a Meta.

## 9. Estado actual del sistema

### Lo que ya funciona

- recepción de `message.received` desde Zernio;
- agrupación de ráfagas;
- creación de lead y conversación;
- respuesta de Sofi con texto libre dentro de una conversación iniciada por el
  cliente;
- almacenamiento de mensajes en el CRM;
- toma y devolución del chat.

### Lo que falta

1. n8n envía directamente a Zernio y no pasa por una política central de
   facturación.
2. No se persiste de manera explícita cuándo vence la ventana de 24 horas.
3. No existe catálogo local de plantillas ni sincronización de estados.
4. No existe endpoint propio para enviar una plantilla.
5. El worker reconoce pero no procesa `message.sent`, `message.delivered`,
   `message.read` y `message.failed`.
6. No se registra `provider_message_id`, categoría, plantilla, estado de entrega
   ni costo estimado.
7. El panel no muestra ventana abierta/cerrada, plantillas ni confirmación de
   costo.
8. No hay presupuesto, tope mensual, consentimiento ni baja comercial.
9. No existe conciliación con la factura real de Meta.

## 10. Cambios necesarios

La implementación debe ser gradual. Ninguna fase debe habilitar envíos pagos
automáticos antes de contar con trazabilidad y límites.

### Fase 0 - Configuración operativa, sin código de envío

1. Confirmar método de pago en la WABA del cliente.
2. Crear manualmente dos plantillas mínimas: recordatorio de visita y
   actualización de consulta.
3. Obtener aprobación y capturar respuestas reales de Zernio.
4. Documentar moneda de facturación y rate card visible en esa WABA.
5. Definir quién puede autorizar marketing y el presupuesto inicial.

**Checkpoint:** tarjeta activa, dos plantillas `APPROVED` y un envío manual de
prueba reflejado en la facturación de Meta.

### Fase 1 - Modelo de datos y auditoría

Crear una migración nueva, sin editar migraciones aplicadas, para representar:

- catálogo `whatsapp_templates` por tenant y `channel_account_id`;
- nombre, idioma, categoría solicitada y efectiva, estado y componentes;
- fecha de sincronización y motivo de rechazo;
- `customer_window_expires_at` en la conversación;
- identificador de mensaje de Zernio/Meta;
- plantilla y categoría utilizadas;
- estado `queued | sent | delivered | read | failed`;
- origen `bot | panel | whatsapp_business_app | automation`;
- costo estimado, moneda, rate y fecha del rate;
- consentimiento y baja para mensajes de marketing.

El costo almacenado será estimado. La factura de Meta seguirá siendo la fuente
contable final.

**Checkpoint:** migración y rollback ensayados; RLS con dos tenants; las
conversaciones existentes siguen funcionando con campos nullable.

### Fase 2 - Adaptador de plantillas en el backend

Agregar, bajo sesión admin y tenant-context:

```text
GET  /v1/integrations/channels/:id/templates
POST /v1/integrations/channels/:id/templates
POST /v1/integrations/channels/:id/templates/sync
```

Agregar para el envío controlado:

```text
POST /v1/conversations/:id/messages
```

Este endpoint debe:

1. verificar permisos y tenant;
2. resolver `channel_account_id` y `conversationId` de Zernio;
3. calcular si la ventana está abierta;
4. rechazar texto libre fuera de ventana;
5. exigir plantilla `APPROVED` e idioma exacto cuando corresponda;
6. validar variables con Zod;
7. comprobar consentimiento para marketing;
8. calcular y guardar costo estimado antes del envío;
9. usar una clave de idempotencia;
10. enviar a Zernio y guardar su identificador.

La API key de Zernio nunca debe llegar al navegador.

**Checkpoint:** tests de texto libre dentro de ventana, rechazo fuera de
ventana, plantilla aprobada, plantilla pausada, variables inválidas,
idempotencia y aislamiento entre tenants.

### Fase 3 - Ciclo de vida por webhooks

Procesar en `zernioWebhook.worker.ts`:

- `message.sent`;
- `message.delivered`;
- `message.read`;
- `message.failed`;
- `whatsapp.template.status_updated`;
- `whatsapp.template.category_updated` si está disponible en la suscripción.

Cada evento debe actualizar por identificador del proveedor, de forma
idempotente. `failed` debe conservar código y detalle sanitizado. Un fallo de
pago no debe marcar el canal como desconectado.

**Checkpoint:** el panel refleja sent, delivered, read y failed; replay del
mismo evento no duplica mensajes ni costos.

### Fase 4 - Centralizar n8n

Reemplazar el `POST` directo de n8n a Zernio por el endpoint del backend. El
backend será el único lugar que decide:

- si se permite texto libre;
- si hace falta plantilla;
- si el chat sigue en bot;
- si el mensaje es pago;
- si existe presupuesto;
- cómo se registra el intento.

Sofi no debe elegir libremente una plantilla de marketing ni generar sus
variables sin validación. Las automatizaciones permitidas deben estar
preconfiguradas por caso de uso.

**Checkpoint:** el agente continúa respondiendo dentro de ventana y cancela el
envío si una persona tomó el chat. Ningún nodo de producción conserva una ruta
alternativa directa que evite los controles.

### Fase 5 - Panel de plantillas y envío

Para administradores:

- listado por número, idioma, categoría y estado;
- sincronización manual;
- creación o importación desde biblioteca;
- detalle del rechazo y categoría efectiva;
- estado del método de pago cuando Zernio/Meta lo expongan, o instrucciones
  para comprobarlo en Meta.

Para vendedores:

- indicador `Ventana abierta hasta ...` o `Se requiere plantilla`;
- selector de plantillas aprobadas compatibles;
- formulario tipado para variables;
- vista previa final;
- costo estimado y confirmación antes de enviar;
- estado de entrega en la conversación.

**Checkpoint:** un vendedor no puede enviar marketing sin permiso ni plantilla;
un admin puede sincronizar estados sin acceder a otro tenant.

### Fase 6 - Presupuestos, consentimiento y operación

Agregar controles por tenant:

- presupuesto mensual y alerta porcentual;
- límite por campaña y cantidad de destinatarios;
- bloqueo al superar el presupuesto, con override solo de admin;
- registro de opt-in, fuente y fecha;
- palabra de baja y lista de supresión;
- frecuencia máxima de marketing por contacto;
- reporte de intentos, entregas, fallos y costo estimado;
- conciliación manual mensual con invoice de Meta.

No se debe automatizar una campaña masiva hasta completar esta fase.

**Checkpoint:** prueba de presupuesto agotado, opt-out inmediato, reintento
idempotente y export de auditoría.

## 11. Política recomendada para la primera versión

Para reducir riesgo comercial y técnico:

1. Mantener las respuestas normales de Sofi dentro de la ventana de 24 horas.
2. Habilitar primero una única plantilla utility: recordatorio de visita.
3. Exigir confirmación manual del vendedor para cada envío fuera de ventana.
4. No habilitar campañas de marketing ni seguimientos autónomos de Sofi.
5. Mostrar siempre costo estimado antes del envío.
6. Revisar factura y categorías durante el primer mes.
7. Recién después evaluar recordatorios automáticos y marketing segmentado.

## 12. Matriz mínima de pruebas

- Cliente escribe y abre/renueva correctamente la ventana de 24 horas.
- Texto libre dentro de ventana se envía y se registra como no facturable según
  la regla vigente.
- Texto libre fuera de ventana es rechazado antes de llamar a Zernio.
- Utility aprobada fuera de ventana se envía con rate estimado.
- Utility dentro de ventana aplica la regla vigente sin cargo.
- Marketing siempre requiere consentimiento y permiso.
- Plantilla `PENDING`, `PAUSED`, `DISABLED` o `REJECTED` no se envía.
- Nombre o idioma incorrecto produce error claro.
- Variables faltantes o adicionales se rechazan.
- Doble clic o retry usa idempotencia y genera un solo envío/costo.
- `delivered` actualiza una sola fila.
- `failed` por pago no desconecta el número.
- Cambio de categoría actualiza futuras estimaciones.
- Un tenant no puede listar ni enviar plantillas de otro.
- Respuesta desde WhatsApp Business pausa el bot aun si había un envío en curso.
- Consultas web y toma de leads continúan sin regresiones.

## 13. Monitoreo

Alertar, como mínimo, sobre:

- aumento de `message.failed`;
- errores de pago o WABA restringida;
- plantilla pausada, rechazada o reclasificada;
- presupuesto cerca del límite;
- diferencia material entre costo estimado y factura;
- envíos fuera de horario o volumen anómalo;
- mensajes de marketing a contactos sin consentimiento.

## 14. Decisiones fuera de alcance inicial

- campañas masivas;
- optimización automática de marketing;
- recobro de costos de Meta dentro de la factura SaaS de Koi;
- prometer equivalencia contable entre estimación e invoice;
- plantillas de autenticación, salvo que aparezca un flujo real de OTP;
- Meta Direct Send como reemplazo general de plantillas, hasta verificar
  elegibilidad y comportamiento de la WABA del cliente.

## 15. Referencias

Fuentes de comportamiento e integración:

- Zernio, pricing de WhatsApp:
  <https://docs.zernio.com/platforms/whatsapp/pricing>
- Zernio, tarifas y separación de facturadores:
  <https://docs.zernio.com/pricing/whatsapp>
- Zernio, plantillas:
  <https://docs.zernio.com/platforms/whatsapp/templates>
- Zernio, envío de mensajes y payload de plantilla:
  <https://docs.zernio.com/messages/send-inbox-message>
- Zernio, Inbox y eventos:
  <https://docs.zernio.com/platforms/whatsapp/inbox>
- Meta, pricing y rate cards, fuente contractual a verificar antes de cada
  lanzamiento:
  <https://developers.facebook.com/docs/whatsapp/pricing>
- Meta Terms for WhatsApp Business:
  <https://www.whatsapp.com/legal/meta-terms-whatsapp-business>

Referencia numérica utilizada para contrastar la rate card USD publicada:

- Rate card USD reproducida por Gupshup, efectiva desde 2025-10-01 y con los
  mismos valores de Argentina observados en referencias 2026:
  <https://www.gupshup.ai/resources/wp-content/uploads/2025/10/USD_Oct2025.pdf>

La indisponibilidad temporal o autenticación requerida por la página de Meta
no convierte a una copia de terceros en fuente contractual. Para aprobar un
presupuesto se debe descargar la rate card vigente desde la cuenta de Meta del
cliente.

