# Plan de implementación: WhatsApp Coexistence y múltiples números

**Fecha:** 2026-08-27  
**Estado:** propuesta para implementar por fases  
**Alcance:** `back-lamelas`, panel `lamelas` y workflow `lamelas-agent`

## Decisión de prioridad

La primera entrega será **Coexistence segura para un único número por tenant**.
La posibilidad de conectar dos o más números queda expresamente diferida hasta
que el primer número haya funcionado en producción y se haya validado la
intervención humana desde la aplicación WhatsApp Business.

Esto divide el trabajo en dos entregas independientes:

- **Entrega A (prioritaria):** Fases 0 a 4. Conectar un número existente por
  Coexistence, coordinar aplicación y bot, y desconectarlo correctamente.
- **Entrega B (diferida):** Fases 5 y 6. Habilitar múltiples números y adaptar
  la operación del CRM.

Durante toda la Entrega A se conservan el índice único, el rechazo del backend
y el bloqueo visual que impiden conectar una segunda cuenta activa.

## 1. Objetivo

Primero, permitir que una inmobiliaria conecte un número que ya utiliza en la
aplicación WhatsApp Business, manteniendo esa aplicación activa mediante
Coexistence y usando al mismo tiempo Zernio, Sofi y el CRM. En una entrega
posterior, extender el mismo modelo para más de un número por tenant.

El resultado debe garantizar que:

- cada mensaje se atribuya al número de la inmobiliaria que lo recibió;
- una respuesta enviada desde WhatsApp Business detenga al bot antes de que
  vuelva a contestar;
- el CRM no mezcle conversaciones si el mismo contacto escribe a dos números;
- conectar o desconectar un número no afecte a los demás;
- el panel muestre el estado real y el modo de conexión de cada número.

## 2. Respuesta sobre el estado actual

### ¿El cliente puede conectar hoy dos o más números?

**No. La aplicación permite actualmente un solo número activo de WhatsApp por
tenant.** Zernio puede administrar varias cuentas dentro de un profile, pero
nuestro sistema impone tres bloqueos propios:

1. La base tiene el índice único parcial
   `channel_accounts_tenant_canal_activa_uq` sobre `(tenant_id, canal)` cuando
   `estado = 'activa'`.
2. `completeConnection` busca una cuenta activa existente y rechaza una segunda
   con el mensaje "Ya hay un número de WhatsApp conectado".
3. El panel oculta `Conectar WhatsApp` cuando existe una cuenta activa y muestra
   "Para cambiar de número, desconectá el actual primero".

Por lo tanto, intentar conectar un segundo número hoy terminaría bloqueado por
el backend, incluso si Meta y Zernio completan la autorización.

### ¿Zernio admite varias cuentas?

Sí. Zernio modela cada número conectado como un `accountId`, permite listar las
cuentas de un mismo `profileId` y enruta los webhooks por `account.id`. El límite
comercial depende del plan y del método de pago de Zernio; no debe confundirse
con la restricción funcional que hoy impone nuestra base.

## 3. Riesgos que deben resolverse antes de habilitarlo

### 3.1 Colisión de conversaciones entre números

Hoy una conversación viva se busca por `canal + canal_ref`, y en WhatsApp
`canal_ref` es el identificador o teléfono del contacto. Si el mismo contacto
escribe al número de ventas y al número de alquileres, el sistema podría
recuperar la misma conversación y mezclar ambos diálogos.

La identidad correcta debe incluir, como mínimo:

```text
tenant + channel_account_id + contacto
```

Además conviene persistir el `conversationId` de Zernio como referencia del
proveedor para respuestas y eventos salientes.

### 3.2 Respuestas desde la aplicación WhatsApp Business

El worker procesa `message.received`, pero hoy marca `message.sent` como
procesado sin ejecutar ninguna acción. En Coexistence, Zernio informa en
`message.source` si el mensaje salió desde `whatsapp_business_app` o desde
`cloud_api`.

Si no se implementa este evento, una persona puede responder desde el teléfono
mientras Sofi sigue en estado `bot`, causando respuestas duplicadas.

Meta/Zernio no identifican necesariamente qué vendedor físico usó el teléfono.
El CRM debe registrar en ese caso:

- atención tomada en una fecha determinada;
- origen `whatsapp_business_app`;
- usuario del panel desconocido (`tomado_por = null`);
- texto visible: "Atendido desde WhatsApp Business".

No se debe atribuir automáticamente esa acción al admin ni al vendedor
asignado, porque sería un dato de auditoría falso.

### 3.3 Carrera entre una respuesta humana y el bot

No alcanza con procesar `message.sent` después de que se envió. El workflow de
n8n debe volver a consultar el estado de la conversación inmediatamente antes
de cada envío. Si está en `humano`, debe cancelar la respuesta generada aunque
la ejecución haya comenzado cuando todavía estaba en `bot`.

### 3.4 Desconexión de Coexistence

La desvinculación de Coexistence se inicia desde la aplicación WhatsApp
Business:

```text
Ajustes > Cuenta > Plataforma empresarial > Desconectar
```

No debe presentarse el `DELETE` actual como si completara por sí solo ese
proceso. El evento `account.disconnected` y el health check deben actualizar
solo la cuenta afectada. Los demás números deben seguir activos.

## 4. Modelo de datos propuesto

Los nombres finales pueden ajustarse durante la implementación, pero el modelo
debe representar explícitamente estos conceptos.

### `channel_accounts`

Agregar:

- `connection_mode`: `coexistence | cloud_api | unknown`;
- `disconnected_at`: fecha efectiva de desconexión;
- opcionalmente `last_health_at` y `last_health_status` para reconciliación.

Eliminar mediante una **migración nueva** el índice único parcial que restringe
un activo por `(tenant_id, canal)`. Conservar como único global
`zernio_account_id`, ya que una cuenta de Zernio no puede pertenecer a dos
tenants.

### `conversations`

Agregar:

- `channel_account_id`, FK nullable a `channel_accounts`;
- `provider_conversation_id`, referencia estable de Zernio.

Las conversaciones WhatsApp nuevas deben buscarse por
`tenant_id + channel_account_id + provider_conversation_id` o, si el proveedor
no lo entrega, por `tenant_id + channel_account_id + canal_ref`.

Los campos empiezan como nullable para no romper conversaciones web ni datos
históricos. Cuando un tenant tenga un único número histórico conocido se puede
hacer backfill seguro. No se debe adivinar el origen cuando haya ambigüedad.

### `leads`

Agregar `tomado_origen`, inicialmente nullable, con valores previstos:

- `panel`;
- `whatsapp_business_app`;
- `sistema` si en el futuro existe otra toma automática.

`tomado_at` seguirá indicando que la atención ya fue asumida. `tomado_por`
continuará siendo nullable para una atención realizada desde la aplicación,
donde no conocemos al usuario real.

## 5. Implementación gradual

Cada fase debe desplegarse y probarse antes de iniciar la siguiente.

### Fase 0 - Caracterización y contratos

1. Capturar payloads reales de `message.received`, `message.sent` desde la app,
   `message.sent` desde Cloud API y `account.disconnected` en un entorno de
   prueba.
2. Confirmar los valores exactos de `message.source`, `accountId`,
   `conversationId` y teléfono para Coexistence.
3. Actualizar el contrato del agente para recibir por separado:
   `channel_account_id`, `provider_conversation_id`, `contact_ref` y `telefono`.
4. Definir que dos números distintos generan conversaciones distintas, aunque
   el contacto sea el mismo. La unificación de contactos queda fuera de este
   cambio.

**Checkpoint:** fixtures sanitizados y tests de contrato que fallen con el
modelo actual y describan el comportamiento esperado.

### Fase 1 - Identidad del número receptor, sin habilitar múltiples números

1. Crear una migración nueva con `connection_mode`, `channel_account_id`,
   `provider_conversation_id` y `tomado_origen` nullable.
2. Extender Prisma, repositorios, selects seguros y RLS.
3. Hacer que el worker pase `accountId` y `conversationId` a n8n.
4. Modificar el workflow y `POST /v1/agent/conversations` para guardar esas
   referencias.
5. Mantener temporalmente el índice de un solo número activo.

**Checkpoint:** el número actual sigue funcionando; un mensaje nuevo deja
registrado el `channel_account_id`; web y WhatsApp mantienen sus pruebas
anteriores; suite RLS con dos tenants en verde.

### Fase 2 - Toma automática al responder desde WhatsApp Business

1. Procesar `message.sent` en el worker.
2. Ignorar para toma automática los mensajes con `source = cloud_api`, evitando
   que una respuesta de Sofi se interprete como humana.
3. Para `source = whatsapp_business_app`:
   - localizar la conversación por cuenta y conversación del proveedor;
   - registrar el mensaje con rol humano y metadata de origen;
   - cambiar la conversación a `humano`;
   - cerrar el handoff pendiente si existe;
   - establecer `tomado_at` y `tomado_origen`, sin inventar `tomado_por`.
4. Agregar al workflow una verificación atómica justo antes de enviar la
   respuesta de Sofi.
5. Mostrar en el panel "Atendido desde WhatsApp Business".

**Checkpoint:** prueba real `bot -> respuesta desde teléfono -> humano`; Sofi no
envía ningún mensaje posterior. Probar también `humano -> devolver al bot` y
una respuesta normal de Cloud API para evitar falsos positivos.

### Fase 3 - Conexión por Coexistence con un solo número

1. Cambiar el connect flow de `onboarding=api` a
   `onboarding=business_app` de manera explícita.
2. Mantener el redirect estándar de Zernio.
3. Exigir o propagar `accountId` en el callback; no seleccionar silenciosamente
   "la primera cuenta activa" cuando existan varias.
4. Guardar `connection_mode = coexistence` al completar.
5. Actualizar textos del panel para explicar que la aplicación seguirá activa
   y que sus respuestas detendrán a Sofi.

**Checkpoint:** conectar un número real ya usado en WhatsApp Business, enviar y
recibir desde ambos lados, verificar historial y comprobar que la app móvil no
se desregistró.

### Fase 4 - Desconexión y reconciliación

1. Procesar `account.disconnected` y marcar únicamente su `accountId` como
   desconectado.
2. Para Coexistence, reemplazar la acción directa por un diálogo con los pasos
   en la app y una acción `Verificar desconexión`.
3. Mantener el `DELETE` remoto solamente para modos donde Zernio documente que
   corresponde o como limpieza posterior confirmada.
4. Ejecutar reconciliación periódica de health para todas las cuentas activas;
   un error en una no debe modificar las demás.
5. Mostrar estado `requiere acción` cuando Meta dejó de servir el número.

**Checkpoint:** desconectar desde el teléfono cambia una sola fila, detiene el
bot de esa línea y deja operativo el resto. Reconectar el mismo número recupera
su registro histórico sin duplicarlo.

### Fase 5 - Habilitar múltiples números (entrega diferida)

1. Eliminar el índice único parcial `(tenant_id, canal) WHERE activa` mediante
   una migración nueva.
2. Retirar `findActivaPorCanal` y el rechazo de segunda cuenta en el service.
3. Hacer obligatorio `accountId` al completar la conexión cuando Zernio pueda
   devolver más de una cuenta.
4. Mantener visible `Conectar otro número` aunque ya exista uno activo.
5. Mostrar número, nombre, modo, estado y fecha de conexión por fila.
6. Tratar límites de plan o pago de Zernio como errores claros, sin convertirlos
   en errores 500.

**Checkpoint:** conectar dos números del mismo tenant, recibir mensajes en
ambos y verificar que el mismo contacto produce dos conversaciones separadas.
Desconectar uno no debe afectar al otro.

### Fase 6 - Operación del CRM con varios números (entrega diferida)

1. Mostrar el número receptor en la tabla y el detalle del lead.
2. Agregar filtro por número receptor.
3. Mantener inicialmente el reparto equitativo global entre vendedores activos.
4. Dejar la asignación de vendedores por número como una fase futura separada;
   no incorporarla hasta que exista un requerimiento comercial concreto.
5. Incorporar health individual y alertas para admins.

**Checkpoint:** un admin puede identificar desde qué línea entró cada consulta,
filtrar por línea y operar todos los leads sin alterar el reparto existente.

## 6. Matriz mínima de pruebas

- Un tenant conecta dos cuentas; otro tenant no puede verlas ni administrarlas.
- El mismo `zernio_account_id` no puede vincularse a dos tenants.
- Un mismo contacto escribe a dos números y se crean dos conversaciones.
- Dos contactos escriben simultáneamente a dos números y los buffers no se
  cruzan.
- `message.sent/source=whatsapp_business_app` pausa el bot y registra atención
  externa.
- `message.sent/source=cloud_api` no toma el lead ni pausa al bot por error.
- El estado se vuelve humano antes del envío tardío de n8n y ese envío se
  cancela.
- `account.disconnected` afecta solo a su cuenta.
- Health fallido de una cuenta no cambia el estado de las demás.
- Reconectar el mismo número reactiva la fila; conectar otro crea otra fila.
- El callback manipulado con un `accountId` ajeno al profile es rechazado.
- Las consultas web continúan sin depender de `channel_account_id`.

## 7. Despliegue recomendado para este cliente

### Entrega A: prioridad actual

1. Completar Fases 0 a 4 manteniendo un solo número activo.
2. Conectar el primer número establecido por Coexistence y observarlo al menos
   48 horas.
3. Validar especialmente respuestas desde teléfonos, toma del chat, devolución
   al bot y desconexión.
4. Considerar terminada esta entrega sin retirar todavía la restricción de una
   cuenta activa.

### Entrega B: después de validar Coexistence

1. Revisar los resultados y payloads reales de la primera línea.
2. Aplicar Fase 5 y conectar el segundo número.
3. Completar Fase 6 y observar ambos números antes de ofrecer multi-número a
   otros tenants.

Rollback funcional: si falla la automatización, poner las conversaciones de la
cuenta afectada en `humano` y conservar WhatsApp Business como canal operativo.
No desconectar el número ni eliminar filas durante un incidente.

## 8. Decisiones explícitamente fuera de alcance

- fusionar automáticamente un contacto que escribe a distintos números;
- asignar vendedores diferentes por número;
- grupos de WhatsApp, no soportados por Coexistence;
- identificar qué persona física respondió desde un teléfono compartido;
- facturación propia por cantidad de números.

## 9. Referencias

- Zernio, conexión y Coexistence:
  <https://docs.zernio.com/platforms/whatsapp/connection>
- Zernio, arquitectura multi-tenant y routing por `accountId`:
  <https://docs.zernio.com/multi-tenant>
- Zernio, Inbox y eventos de mensajes:
  <https://docs.zernio.com/platforms/whatsapp/inbox>
- Zernio changelog, `message.source` para distinguir app y Cloud API:
  <https://docs.zernio.com/changelog>
