# Prueba de Zernio en producción antes de conectar el número de Lamelas

**Objetivo:** validar de punta a punta la conexión WhatsApp → Zernio → backend → n8n → Sofi → CRM usando primero un número secundario. Solo después de completar y limpiar esta prueba se conecta el número real de Lamelas.

**Alcance:** este procedimiento usa el tenant y el perfil Zernio de Lamelas en producción. El número real de Lamelas no se selecciona ni se modifica durante la prueba.

## 1. Estado esperado antes de empezar

La integración ya debe tener:

- Backend desplegado con la migración `20260817222455_channel_accounts_zernio` aplicada.
- Pantalla **Conectar número** disponible en el panel.
- Workflow de Zernio activo y probado en n8n.
- Variables cargadas en Dokploy:
  - `ZERNIO_API_KEY`
  - `ZERNIO_WEBHOOK_SECRET`
  - `ZERNIO_REDIRECT_BASE_URL`
  - `N8N_WHATSAPP_WEBHOOK_URL`
  - `ZERNIO_BUFFER_MS`
- Ningún canal activo en el panel: **Números conectados (0)**.

No copiar secretos en este documento, capturas, tickets ni logs.

## 2. Qué elementos participan

```text
Team de Koi en Zernio
└── Profile de Lamelas (persistente)
    ├── cuenta WhatsApp de prueba (temporal)
    └── cuenta WhatsApp real de Lamelas (se conecta después)

Tenant Lamelas en el backend
└── channel_accounts
    ├── fila del número de prueba → queda desconectada al terminar
    └── fila del número real → será la activa definitiva
```

El **profile de Lamelas no se borra ni se reemplaza** al cambiar de número. Su ID está guardado en `tenants.zernio_profile_id` y se reutiliza. Cada número conectado es una cuenta social distinta dentro de ese profile.

El backend admite una sola cuenta WhatsApp activa por tenant. Al desconectar el número de prueba se libera ese lugar y se puede conectar el número real.

## 3. ¿Se puede probar con un chip nuevo sin WhatsApp?

Sí. De hecho, es la alternativa más segura si el número no se usa para nada importante.

El chip debe:

- Tener un número que pueda recibir SMS o llamadas para el código de verificación de Meta.
- Estar activo y con señal durante el alta.
- No estar registrado actualmente en WhatsApp ni WhatsApp Business, o estar disponible para una migración deliberada.
- Poder quedar asociado temporalmente a una WhatsApp Business Account (WABA) durante la prueba.

No hace falta crear primero una cuenta en la aplicación móvil de WhatsApp. El flujo de Meta Embedded Signup puede registrar un número nuevo directamente en WhatsApp Business Platform/Cloud API.

### Qué puede pedir Meta

- Inicio de sesión con una cuenta Meta autorizada.
- Elegir o crear una Meta Business Account.
- Elegir o crear una WABA.
- Nombre visible del negocio.
- Verificación del número por SMS o llamada.
- En algunos casos, verificación del negocio o revisión del nombre visible.

Para una prueba interna iniciada por el usuario —el usuario escribe primero al bot— no debería hacer falta una plantilla para responder dentro de la ventana de atención de 24 horas. Las conversaciones iniciadas por el negocio fuera de esa ventana sí requieren plantillas aprobadas.

### Qué número no conviene usar

No usar como prueba:

- Un número personal importante.
- Un número que atienda clientes actualmente.
- Un número registrado en WhatsApp personal que no se quiera migrar.
- Un número de WhatsApp Business cuyo funcionamiento en el teléfono deba preservarse.

El backend inicia el connect flow con `onboarding=api`. La prueba debe asumirse como una conexión Cloud API completa. No depender del modo de coexistencia con la app móvil salvo que Meta lo ofrezca explícitamente y se haya decidido probar ese modo.

## 4. Impacto sobre Lamelas durante la prueba

### Lo que no se afecta

- El número real de Lamelas, mientras no se seleccione en Meta.
- Sus chats actuales de WhatsApp.
- Sus contactos de WhatsApp.
- Su teléfono o SIM real.
- El ID del profile Zernio de Lamelas.
- Las propiedades y usuarios existentes.

### Lo que sí usa producción

La prueba pasa por el tenant real de Lamelas. Puede generar:

- Leads con `canal = whatsapp`.
- Conversaciones y mensajes.
- Notas generadas por el agente.
- Handoffs y asignaciones a vendedores.
- Cambios en contadores de consultas.
- Ejecuciones reales de n8n y consumo del modelo de IA.
- Notificaciones o actividad visible para usuarios reales del panel.

Usar nombres reconocibles, por ejemplo:

```text
PRUEBA ZERNIO PRODUCCIÓN - NO CONTACTAR
```

Hacerla fuera del horario de atención y avisar a quienes puedan recibir una derivación. Si es posible, mantener controlado qué vendedor está disponible durante la prueba.

## 5. Cuenta, cupo y facturación de Zernio

El número de prueba ocupa una **connected account** del team de Zernio mientras esté conectado. Al desconectarlo deja de estar activo y luego el número real ocupa su lugar.

Consideraciones:

- Las primeras cuentas conectadas pueden estar cubiertas por el free tier vigente de Zernio.
- Si el team supera el cupo gratuito, la cuenta temporal puede generar un cargo prorrateado por los días conectada.
- Un número propio no es lo mismo que comprar un número provisionado por Zernio: no debería generar el alquiler de un número Zernio, aunque sí cuenta como cuenta social conectada.
- Meta puede facturar por separado mensajes de plantilla a la WABA. Las respuestas libres dentro de la ventana de atención no tienen el mismo tratamiento que una conversación iniciada por plantilla.

Revisar precios y límites vigentes antes de la prueba:

- <https://docs.zernio.com/pricing>
- <https://docs.zernio.com/platforms/whatsapp/pricing>

## 6. Preparar el webhook de producción

El webhook usado para pruebas locales no alcanza para producción. Crear o habilitar uno que apunte a:

```text
https://api.inmobiliarialyc.com.ar/webhooks/zernio
```

Configuración mínima recomendada:

```json
{
  "name": "lamelas-whatsapp-production",
  "url": "https://api.inmobiliarialyc.com.ar/webhooks/zernio",
  "events": [
    "message.received",
    "account.disconnected"
  ],
  "secret": "EL_MISMO_VALOR_DE_ZERNIO_WEBHOOK_SECRET",
  "isActive": true
}
```

No pegar el secreto real en comandos guardados en el historial. Cargarlo mediante el dashboard o un mecanismo que no lo deje expuesto.

Los webhooks de Zernio son del team, no uno por profile. Cada evento incluye `account.id`/`account.accountId`; el backend usa ese ID para resolver el tenant.

### Webhook local existente

Antes de la prueba:

- Desactivar el webhook local, o confirmar que su URL sigue siendo alcanzable y que se desea recibir duplicados allí.
- Evitar dejarlo activo apuntando a un túnel apagado: generará fallos y ruido en los delivery logs.
- Confirmar que el webhook de producción está activo y usa el secret configurado en el VPS.

Zernio puede desactivar webhooks después de fallos consecutivos. Revisar los delivery logs si no llega un mensaje.

Documentación: <https://docs.zernio.com/webhooks/create-webhook-settings>

## 7. Conectar el número de prueba

1. Entrar al panel de producción como admin de Lamelas.
2. Abrir **WhatsApp → Conectar número**.
3. Confirmar que se muestra **Números conectados (0)**.
4. Presionar **Conectar WhatsApp**.
5. En Meta, verificar cuidadosamente qué Business Account, WABA y número se seleccionan.
6. Seleccionar únicamente el número de prueba.
7. Completar la verificación por SMS o llamada.
8. Volver al callback del panel.
9. Confirmar que aparece exactamente un número conectado y que es el de prueba.
10. Usar **Verificar** y confirmar que Zernio informa el canal como saludable.

### Criterios para frenar

Cancelar el flujo si:

- Meta muestra el número real de Lamelas preseleccionado.
- No está claro qué WABA se está usando.
- Se solicita migrar un número personal o productivo que no debía tocarse.
- El callback muestra un número distinto del de prueba.
- El panel muestra más de una cuenta activa.

## 8. Smoke test de punta a punta

Desde un tercer teléfono, enviar al número de prueba una secuencia como:

```text
Hola
Busco un departamento
En Yerba Buena
Hasta USD 120.000
```

Esperar al menos `ZERNIO_BUFFER_MS` más el intervalo del worker. Verificar:

1. Zernio registra una entrega `message.received` con respuesta HTTP 200.
2. El backend crea eventos en `channel_webhook_events`.
3. La ráfaga se procesa una sola vez y pasa a `procesado`.
4. n8n recibe un objeto con `tenant_id`, `canal` y `data` como array.
5. El workflow crea o reutiliza un lead y una conversación.
6. Sofi responde al número que escribió.
7. La consulta aparece en `/consultas` para el administrador, pero permanece
   oculta para los vendedores mientras Sofi la atiende sin asignación.
8. Mensajes consecutivos de la misma ráfaga no generan respuestas duplicadas.
9. La búsqueda de propiedades usa datos reales pero no expone `notas` internas.
10. La derivación asigna un vendedor correctamente y recién entonces la
    consulta aparece en su panel y en su contador pendiente.
11. La toma desde el panel registra `tomadoAt`/`tomadoPor`, pasa la conversación a humano y cierra el handoff pendiente.
12. Después de la toma, Sofi no vuelve a responder automáticamente en esa conversación.

También probar una caída controlada de n8n solo si se puede observar y revertir de inmediato: el evento debe quedar pendiente y procesarse en un reintento posterior.

## 9. Desconectar el número de prueba

1. Terminar cualquier conversación activa de prueba.
2. Desde el panel, usar **Desconectar**.
3. Confirmar que el panel vuelve a **Números conectados (0)**.
4. Entrar al dashboard de Zernio y verificar que la cuenta WhatsApp de prueba ya no figura conectada/activa.
5. Consultar nuevamente la salud del canal: no debe seguir apareciendo como operativo.
6. Revisar los delivery logs para asegurar que no siguen entrando eventos de esa cuenta.

El paso 4 es obligatorio. El backend intenta borrar la cuenta en Zernio, pero la desconexión remota es best-effort: si la llamada a Zernio falla, igualmente marca la fila local como desconectada. No conectar el número real hasta verificar ambos lados.

### Qué queda después de desconectar

- El profile Zernio de Lamelas permanece.
- La fila local del número de prueba permanece con estado desconectado para conservar trazabilidad.
- Los leads, conversaciones y mensajes creados durante la prueba permanecen hasta limpiarlos.
- La asociación del número con una WABA puede seguir existiendo del lado de Meta aunque la cuenta se quite de Zernio. Si el chip se reutilizará fuera de Cloud API, revisar y limpiar también la configuración en Meta Business Suite.

No confundir **desconectar la cuenta social** con **liberar un número comprado a Zernio**. Este procedimiento usa un número propio y no debe llamar al endpoint de release de números provisionados.

## 10. Limpieza de datos de prueba

Después de desconectar:

- Eliminar desde el panel los leads marcados como prueba.
- Confirmar que el cascade eliminó conversaciones, mensajes y handoffs asociados.
- Revisar que no haya handoffs pendientes de prueba.
- Confirmar que ningún vendedor quedó con una conversación de prueba activa.
- Conservar solamente logs técnicos que no contengan mensajes, tokens ni datos personales.

No borrar el profile Zernio de Lamelas ni limpiar manualmente `tenants.zernio_profile_id`.

## 11. Conectar el número real de Lamelas

Avanzar únicamente si:

- El smoke test completo fue exitoso.
- El número de prueba figura desconectado tanto en el panel como en Zernio.
- El panel muestra cero números conectados.
- Los datos operativos de prueba fueron limpiados.
- Está claro si el número real usará Cloud API-only o coexistencia con WhatsApp Business App.
- Lamelas conoce cualquier cambio que pueda afectar el uso del teléfono.
- La WABA tiene medio de pago si se usarán templates fuera de la ventana de 24 horas.

Luego repetir la conexión seleccionando el número real y hacer un smoke test corto con una consulta controlada.

## 12. Resultado que debe quedar documentado

Registrar sin secretos:

- Fecha y hora de inicio/fin.
- Número de prueba parcialmente oculto, por ejemplo `+54 9 381 *** 1234`.
- Cuenta Meta/WABA elegida, usando nombre visible y no tokens.
- ID del profile Zernio de Lamelas.
- ID de la cuenta Zernio temporal.
- Estado del health check.
- ID del evento de prueba y estado final de la cola.
- Ejecución de n8n asociada.
- Lead/conversación creados y luego eliminados.
- Confirmación de desconexión local y remota.
- Incidentes o diferencias respecto de este runbook.
- Aprobación para conectar el número real.

## Referencias

- Conexión de WhatsApp y Embedded Signup: <https://docs.zernio.com/platforms/whatsapp/connection>
- Webhooks de Zernio: <https://docs.zernio.com/webhooks>
- Crear configuración de webhook: <https://docs.zernio.com/webhooks/create-webhook-settings>
- Desconectar una cuenta: <https://docs.zernio.com/accounts/delete-account>
- Estado real del número: <https://docs.zernio.com/platforms/whatsapp/phone-numbers>
- Precios: <https://docs.zernio.com/pricing>
