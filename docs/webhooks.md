# Webhooks — Registro y Contrato de Integraciones

**Referencia:** `api-spec.md` §10 (gestión), `diagrama-er.md` (`webhook_endpoints`, `webhook_deliveries`)
**Propósito:** permitir integraciones salientes sin acoplar el core: sincronización con portales (Zonaprop/MercadoLibre vía middleware), automatizaciones (n8n/Make), notificaciones (Slack/WhatsApp), CRMs.

## 1. Modelo

- Un **endpoint** = URL + lista de eventos suscriptos + secret. Alcance: por tenant (lo configura el admin) o global de plataforma (super admin, ej. analytics de Koi).
- Cada evento emitido genera una **delivery** por endpoint suscripto, con registro completo (payload, intentos, status) consultable en `GET /webhooks/:id/deliveries`.

## 2. Catálogo de eventos

| Evento | Disparador | Payload `data` |
|---|---|---|
| `property.updated` | Edición de campos | property + `changed_fields[]` |
| `property.created` | Alta de propiedad (visible al público de inmediato) | property (pública) |
| `property.estado_changed` | disponible/reservada/vendida | `{ property_id, estado_anterior, estado }` |
| `property.deleted` | Eliminación | `{ property_id }` |
| `lead.created` | Lead nuevo (web, manual o conversación iniciada por Sofía) | lead + property resumida + `canal` |
| `lead.updated` | Cambio de estado, asignación o primera toma | lead, incluidos `tomado_at` y `tomado_por` |
| `lead.assigned` | Sofía deriva o reasigna una conversación a un vendedor | `{ lead_id, conversation_id, vendedor_id, motivo, handoff_id }` (se emite, pero ver limitación debajo) |
| `user.invited` | Invitación emitida | `{ email, rol }` |
| `user.joined` | Invitación aceptada | user (sin hash) |
| `tenant.created` | Alta de inmobiliaria (solo global) | tenant |
| `tenant.suspended` | Suspensión (solo global) | `{ tenant_id, motivo }` |
| `ping` | `POST /webhooks/:id/test` | `{}` |

Los payloads **nunca incluyen** `notas` internas, hashes ni tokens.

**Limitación actual:** `lead.assigned` existe en `EventName` y se emite desde el
servicio del agente, pero falta en `EVENTOS_VALIDOS`. Por eso la API todavía no
permite seleccionarlo al crear o editar un endpoint. Hasta corregir ese catálogo,
el evento no genera deliveries para suscripciones creadas por la API.

## 3. Formato de entrega

`POST` a la URL del endpoint:

```json
{
  "id": "d3f0…",              // delivery id (idempotencia)
  "evento": "property.created",
  "tenant_id": "…",
  "created_at": "2026-07-10T14:00:00Z",
  "data": { … }
}
```

Headers:

```
Content-Type: application/json
X-Koi-Event: property.created
X-Koi-Delivery: <delivery_id>
X-Koi-Signature: sha256=<HMAC-SHA256(secret, raw_body)>
X-Koi-Timestamp: <unix>
```

**Verificación del receptor:** recomputar el HMAC sobre el body crudo y comparar en tiempo constante; rechazar si `|now - timestamp| > 5 min` (anti-replay). El receptor debe ser **idempotente** por `X-Koi-Delivery` (los reintentos reenvían el mismo id).

## 4. Entrega y reintentos (patrón outbox)

1. El service escribe el evento en `webhook_deliveries` **dentro de la misma transacción** del cambio de negocio (outbox: nunca se pierde un evento ni se emite uno de una transacción rollbackeada).
2. Un worker interno (loop en el mismo proceso, sin Redis en MVP) toma pendientes y hace el POST. Timeout 10 s.
3. Éxito = HTTP 2xx. Otro status o timeout suma un intento. Hay hasta **5 intentos totales**, con esperas de **1 min → 5 min → 30 min → 2 h** entre ellos; después queda `fallida`.
4. El código actual no auto-desactiva endpoints por fallas consecutivas ni envía un email por ese motivo.
5. Tampoco existe todavía un job de retención/limpieza de deliveries.

El worker selecciona pendientes y recién actualiza su estado después del POST;
no hay un reclamo atómico previo. Como el `setInterval` tampoco espera la pasada
anterior, una entrega lenta, dos réplicas o dos pasadas superpuestas pueden
enviar la misma delivery en paralelo. El receptor debe mantener idempotencia por
`X-Koi-Delivery`, pero la cola todavía necesita un mecanismo de claim/lease.

## 5. Seguridad

- Secret por endpoint, generado por la plataforma (32 bytes hex), visible una sola vez al crear; rotable (`PATCH /webhooks/:id` con `{ rotate_secret: true }`).
- Solo HTTPS. URLs a IPs privadas/loopback rechazadas (anti-SSRF).
- El worker envía desde el VPS con `User-Agent: KoiPlataforma-Webhooks/1.0`.

## 6. Integraciones previstas (consumidores)

| Integración | Eventos | Nota |
|---|---|---|
| Sitios de clientes (módulo export) | `property.created/updated/deleted` | Aviso de cambios para invalidar cache/sincronizar réplicas (`api-spec.md` §9) |
| Sync portales (Zonaprop/ML) | `property.created/updated/deleted` | Middleware traductor por portal, post-MVP; el contrato ya lo soporta |
| n8n / automatizaciones Koi | `lead.created`, `lead.updated`, `property.*` | `lead.assigned` requiere corregir primero el catálogo de eventos |
| Métricas Koi (global) | `tenant.*`, `user.joined` | Endpoint global super admin |

## 7. Webhook entrante de Zernio

El endpoint `POST /webhooks/zernio` recibe eventos de WhatsApp antes del parser JSON global para poder verificar la firma HMAC sobre el body crudo. El backend deduplica por id de evento y procesa la cola de forma asíncrona:

- `message.received`: agrupa mensajes por cuenta y conversación durante `ZERNIO_BUFFER_MS` (8 s por defecto) y envía el lote al workflow de n8n configurado en `N8N_WHATSAPP_WEBHOOK_URL`.
- `message.sent` con `source = whatsapp_business_app`: registra intervención humana, pasa la conversación a modo humano, cierra handoffs pendientes y marca la primera toma con origen `whatsapp_business_app`.
- `message.sent` con `source = cloud_api`: se audita, pero no se interpreta como toma humana porque puede ser una respuesta automática de Sofía.

La identidad de conversación se resuelve por proveedor, cuenta y referencia externa; no por número de teléfono solamente. Instagram y Messenger continúan sin conector entrante.
