# Especificación de API — Ubikka

> Documento heredado en actualización. Para las adiciones del dashboard de 2026-10-01 y su validación, ver [README](../README.md#dashboard-contratos-nuevos--2026-10-01). Las rutas del código y sus pruebas son la referencia ejecutable; los dominios y políticas del prototipo no definen el despliegue de Ubikka.

**Base URL local de Ubikka:** `http://localhost:3001/v1` · **Formato:** JSON
**Auth interna:** cookies httpOnly (access + refresh) + header CSRF en mutations · **Auth de integraciones:** `X-Api-Key` con scopes
**Referencia:** `permisos-rls.md` (matriz de permisos), `diagrama-er.md` (entidades). Este Markdown es el contrato documentado actual; el proyecto no expone hoy una spec OpenAPI generada ni una ruta `/docs`.

## 1. Convenciones

- **Versionado por path** (`/v1`). Cambios breaking ⇒ `/v2`.
- **Paginación:** `?page=1&limit=24` (máx. 100) → respuesta `{ data: [...], meta: { page, limit, total } }`.
- **Filtros y búsqueda en query params** (mismos criterios que el MVP: compartibles por URL).
- **Fechas:** ISO 8601 UTC. **IDs:** UUID v4. **Idioma de mensajes de error:** español (AR).
- Campos de negocio en español (`titulo`, `operacion`...), igual que la BD.

## 2. Errores

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "El precio es obligatorio.", "details": [{ "field": "precio", "message": "Requerido" }] } }
```

| HTTP | code | Uso |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Zod falló |
| 401 | `UNAUTHORIZED` | Sesión/cookie o API key ausente, expirada o inválida |
| 403 | `FORBIDDEN` | Rol/RLS/CSRF deniega |
| 404 | `NOT_FOUND` | No existe o RLS lo oculta (indistinguible a propósito) |
| 409 | `CONFLICT` | Estado ilegal, email o slug duplicado |
| 422 | `LIMIT_EXCEEDED` | Límites fijos (ej. 20 fotos por propiedad) |
| 429 | `RATE_LIMITED` | Rate limit (login, endpoints públicos, export) |
| 500 | `INTERNAL` | Error no manejado (sin detalles internos) |

## 3. Auth (sesión por cookies)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| POST | `/auth/login` | — | `{ email, password }` → setea cookies `access_token` (15 min) y `refresh_token` (30 días, path `/v1/auth`) httpOnly/Secure/SameSite=Lax + devuelve `{ user, csrf_token }`. Rate limit 5/min/IP. Error genérico (no revela si el email existe) |
| POST | `/auth/refresh` | cookie refresh | Rota el refresh (el usado se revoca) y renueva ambas cookies + nuevo `csrf_token` |
| POST | `/auth/logout` | ✔︎ | Revoca el refresh actual (o todos con `{ all: true }`) y limpia cookies |
| POST | `/auth/forgot-password` | — | `{ email }` → siempre 200 (mismo mensaje exista o no) |
| POST | `/auth/reset-password` | — | `{ token, password }` (≥ 8 chars) |
| POST | `/auth/accept-invitation` | — | `{ token, nombre, password }` → crea el usuario con el rol/tenant de la invitación y setea sesión |
| GET | `/auth/me` | ✔︎ | Usuario actual + tenant + rol |

- Access JWT: claims `{ sub, tenant_id, rol }`. Refresh: rotativo, hash en BD.
- **CSRF (double-submit):** toda mutation exige header `X-CSRF-Token` igual al token entregado en login/refresh. GETs no lo requieren.
- **No hay registro abierto:** todo usuario entra por invitación (cierra el riesgo "registro abierto" del PRD) o por onboarding de tenant (ver `onboarding.md`).

## 4. Tenants

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/tenants` | super_admin | Lista con estado y contadores |
| POST | `/tenants` | super_admin | `{ nombre, slug, admin_email }` → crea tenant + invitación de admin (ver `onboarding.md`) |
| GET | `/tenants/current` | admin, agente | Tenant propio con config |
| PATCH | `/tenants/current` | admin | `{ logo_url?, config_sitio?, agente_activo?, seguimiento_activo?, seguimiento_mensaje_1?, seguimiento_mensaje_2? }`. Los mensajes son texto no vacío de hasta 1000 caracteres |
| PATCH | `/tenants/:id` | super_admin | Suspender/reactivar |

*(Dominios/subdominios custom: fuera de alcance por ahora.)*

## 5. Usuarios y equipo

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/users` | miembros | Equipo del tenant (`?estado=activo`) |
| POST | `/invitations` | admin | `{ email, rol }` (admin\|agente) → email con link, expira 7 días |
| GET/DELETE | `/invitations`, `/invitations/:id` | admin | Listar pendientes / revocar |
| PATCH | `/users/:id` | admin | `{ rol?, estado? }` — no puede tocar super_admins ni degradarse a sí mismo si es el último admin |
| PATCH | `/users/me` | ✔︎ | `{ nombre? }` |
| POST | `/users/me/password` | ✔︎ | `{ current_password, new_password }` |
| POST | `/users/:id/password` | admin, super_admin | `{ new_password, notify? }` — cambia la contraseña de un usuario, revoca sus sesiones activas y opcionalmente envía email con contraseña temporal. No modifica `super_admins` |

## 6. Propiedades

**Sin fricción (decisión de producto):** el agente registra la propiedad y queda visible en el sitio público de inmediato. **No hay flujo de aprobación** (borrador/revisión) — mismo comportamiento que el MVP de Lamelas. La tabla es la misma del MVP + `link_maps` opcional (link de Google Maps).

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/properties` | miembros | Todas las del tenant. Filtros: `operacion, tipo, estado, vendedor, dormitorios` (mínimo), `q` (título/dirección). Orden `created_at desc`, paginado 24 |
| GET | `/properties/mine` | miembros | Las del usuario + contadores por estado |
| POST | `/properties` | admin, agente | Alta rápida: `{ titulo, operacion, tipo, precio, moneda? }` (moneda default ARS) → nace `disponible` y ya visible públicamente |
| GET | `/properties/:id` | miembros | Ficha completa con imágenes ordenadas (portada primero) |
| PATCH | `/properties/:id` | dueño/admin | Cualquier campo opcional (descripción, dirección, zona, ciudad, ambientes, superficies, notas, `requisitos`, campos de alquiler `destino/plazo_contrato/plazo_otro/ajuste/ajuste_otro/indice_ajuste/indice_fijo_pct/expensas/mascotas/amoblado`, mapa `lat/lng/link_maps`...) |
| DELETE | `/properties/:id` | dueño/admin | Borra fila + imágenes en R2 |
| PATCH | `/properties/:id/estado` | dueño/admin | `{ estado: disponible\|reservado\|proximamente\|pausado\|vendida\|alquilada }` |

## 7. Imágenes

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| POST | `/properties/:id/images/presign` | dueño/admin | `{ count }` → valida límite 20 → `[{ upload_url, r2_key }]` (PUT presignado, expira 10 min) |
| POST | `/properties/:id/images/confirm` | dueño/admin | `[{ r2_key }]` → crea filas; primera = portada |
| PATCH | `/images/:id/portada` | dueño/admin | Marca portada única (desmarca la anterior) |
| PATCH | `/properties/:id/images/order` | dueño/admin | `{ ids: [...] }` reordena |
| DELETE | `/images/:id` | dueño/admin | Borra fila + objeto R2; si era portada, promueve la siguiente |

## 8. CRM (leads)

Gestión de consultas/leads. Canales activos en el código: formularios del sitio (`web`), alta manual, probador web de Sofía y WhatsApp mediante Zernio. El modelo también contempla `instagram` y `messenger`, pero esos conectores todavía no están implementados.

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| POST | `/public/:tenant_slug/leads` | public | `{ property_id?, nombre, email?, telefono?, mensaje }`. Rate limit + honeypot. `canal = web`. Con propiedad asigna al usuario que la cargó; sin propiedad reparte entre vendedores activos por round-robin. Si no hay disponibles, crea sin asignar y avisa a admins → email + evento `lead.created` |
| GET | `/leads` | admin, agente | Admin: todos; agente: asignados, de sus propiedades y libres, salvo WhatsApp sin asignar mientras Sofía lo atiende. Cada lead incluye `tomadoAt`, `tomadoPor`, `tomadoOrigen` (`panel\|whatsapp_business_app\|sistema`) y `takenBy` (`id`, `nombre`; null si no se conoce la persona física). Filtros: `estado, canal, clasificacion, assigned_to, property_id, sin_tomar, q` (nombre/email/teléfono). `sin_tomar=true` filtra `tomadoAt=null`; `false`, los ya tomados |
| POST | `/leads` | admin, agente | Alta manual (`canal = manual`), ej. consulta telefónica |
| POST | `/leads/:id/take` | admin, agente asignado o agente sobre lead libre no WhatsApp | Registra la primera toma de forma idempotente y transfiere `assignedTo` al usuario actual. Un WhatsApp controlado por Sofía debe pasar primero por el handoff. No cambia `estado`. Si hay conversación activa, la pasa a humano y cierra el handoff pendiente |
| POST | `/conversations/:id/take` | admin, agente asignado | Toma el chat mediante la misma operación universal: marca y asigna el lead al usuario actual, pasa la conversación a humano y cierra el handoff |
| GET | `/leads/:id` | quien lo ve | Lead + notas de seguimiento + propiedad asociada + datos de toma (`tomadoAt`, `tomadoPor`, `tomadoOrigen`, `takenBy`) |
| PATCH | `/leads/:id` | admin, agente asignado | `{ estado?: nueva\|en_contacto\|ganada\|perdida, clasificacion?: potencial\|fantasma\|null, assigned_to? }` (reasignar: solo admin) → evento `lead.updated`. Marcar `fantasma` manualmente apaga a Sofía y cancela seguimientos, pero no asigna ni cambia el responsable |
| POST | `/leads/:id/notes` | quien lo ve | `{ nota }` — historial de seguimiento |
| GET | `/leads/stats` | admin | Contadores por estado, canal y clasificación (`por_clasificacion`, con `sin_clasificar` para los null) |

### Analíticas comerciales (MVP)

Los indicadores del MVP son de solo lectura y exclusivos para administradores.
Miden una **cohorte de leads creados dentro del período**, observada en su estado
actual; no representan la fecha histórica en la que un lead cambió de etapa.
Los chats web de prueba (`canal=web` con `canal_ref`) se excluyen.

Filtros comunes: `from`, `to` (`AAAA-MM-DD`, máximo 366 días), `timezone`
(IANA), `canal`, `seller_id`, `operacion`, `tipo`, `zona` y `clasificacion`.
Sin fechas se usan los últimos 30 días según `America/Argentina/Tucuman`.

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/analytics/overview` | admin | KPIs de altas, toma, estado actual, conversaciones de Sofía, handoffs e inventario disponible |
| GET | `/analytics/leads` | admin | Volumen diario, distribuciones, asignación, origen de toma, mediana/P90 y pendientes por antigüedad |

## 9. Export (info pública para sitios y plataformas de clientes)

Para clientes que tienen su propio sitio web u otra plataforma y necesitan consumir sus propiedades. Autenticación por **API key** (`X-Api-Key: <key>`); la key identifica al tenant y expone sus propiedades **sin campos internos** (`notas`, `user_id`, datos de otros tenants). Solo lectura. El campo `estado` sí se expone para que el sitio del cliente pueda filtrar (ej. mostrar solo disponibles).

**Gestión (panel, admin):**

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET/POST | `/api-keys` | admin | Listar (solo `prefix`) / crear `{ nombre }` → devuelve la key completa **una sola vez** |
| DELETE | `/api-keys/:id` | admin | Revocar |

**Consumo (con `X-Api-Key`, rate limit 120 req/min por key, CORS abierto):**

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/export/properties` | Propiedades del tenant. Filtros: `operacion, tipo, estado, zona, ciudad, precio_min, precio_max, ambientes, dormitorios_min, updated_since` (sync incremental). Orden: `sort=recent\|price-asc\|price-desc`. Paginado (`page`, `limit` máx. 100) |
| GET | `/export/properties/:idOrSlug` | Ficha pública + galería (URLs absolutas). Resuelve por uuid o por `slug` |
| GET | `/export/ciudades` | Ciudades con inventario, alfabéticas y sin repetir. Filtro opcional `estado` — puebla el selector del sitio sin traer el listado entero |
| GET | `/export/site` | Datos de la inmobiliaria (nombre, logo, config de contacto) |

`ambientes` y `dormitorios_min` son **mínimos** (`3` ⇒ 3 o más), criterio inmobiliario. Sin filtro `estado` se devuelve todo: cada sitio decide si muestra reservadas o vendidas. El orden lleva `id` como criterio secundario para que la paginación no duplique ni saltee filas.

Cache: `s-maxage=60, stale-while-revalidate`. `updated_since` + webhooks (`property.published/updated/...`, ver `webhooks.md`) permiten a los clientes mantener réplicas sincronizadas sin polling agresivo. Estos mismos endpoints servirán al futuro sitio público propio de la plataforma.

## 10. Webhooks (gestión)

Ver `webhooks.md` para el contrato de entrega. Gestión:

| Método | Ruta | Rol |
|---|---|---|
| GET/POST | `/webhooks` | admin (del tenant), super_admin (globales con `?scope=global`) |
| PATCH/DELETE | `/webhooks/:id` | idem |
| GET | `/webhooks/:id/deliveries` | idem — últimas entregas con status y payload |
| POST | `/webhooks/:id/test` | idem — envía evento `ping` |

## 11. Plataforma

### Canales de mensajeria

`GET /integrations/channels` devuelve las cuentas visibles para el admin del
tenant. Cada cuenta incluye `connection_mode` (`unknown`, `coexistence` o
`cloud_api`) y `disconnected_at` nullable, ademas del estado y snapshot del
numero. Estos campos son aditivos y no cambian el contrato `/v1` existente.

El workflow Zernio abre conversaciones con `channel_account_id` y
`provider_conversation_id` además de `canal_ref`. Ambos campos se envían juntos
y permiten resolver una conversación por cuenta + ID del proveedor. Un
`message.sent` con `source=whatsapp_business_app` se registra como mensaje de
vendedor, silencia el bot y marca la atención con usuario desconocido; uno con
`source=cloud_api` sólo se audita y nunca se interpreta como intervención humana.

### Seguimiento automático de WhatsApp

`agente_activo` es el interruptor global de Sofía para el tenant. Cuando está
en `false`, `conversation.bot_activo` se devuelve en `false` aunque la
conversación conserve `estado=bot`, y se cancelan todos los seguimientos
pendientes. Al volver a encenderlo no se reponen vencimientos anteriores: Sofía
retoma en el próximo mensaje entrante de cada conversación que siga en `bot`.
Este interruptor es independiente de `seguimiento_activo`.

Una respuesta normal de Sofía programa dos recontactos con intervalos continuos
de dos horas, sin pausa por horario laboral. Cada mensaje entrante del lead o
una intervención humana cancela el vencimiento pendiente. Dos horas después del
segundo recontacto sin respuesta, el backend clasifica el lead como `fantasma`,
lo asigna por round-robin y pasa la conversación a `esperando_humano`.

El handoff generado lleva `motivo=seguimiento_sin_respuesta` y
`reasignable=false`, por lo que no entra al cron de handoffs vencidos. El worker
usa claim con lease, envía a Zernio fuera de la transacción y solo avanza la
etapa después de un envío exitoso. Si no hay vendedor, reintenta la finalización
sin apagar a Sofía.

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/health` | — | Liveness (BD incluida) para monitoreo |
| GET | `/admin/metrics` | super_admin | Tenants activos, propiedades, usuarios, leads por período |

## 12. Herramientas del agente: búsqueda e identificación

Todas las rutas siguientes tienen prefijo `/v1`, autenticación `X-Api-Key`,
scope `agent:read` y contexto RLS `agent` del tenant de la key. No devuelven
`notas`, `user_id` ni `tenant_id` de propiedades. Ampliación aditiva de 2026-08-30.

### Buscar opciones

`GET /agent/properties`: conserva `q`, `operacion`, `tipo`, `estado`, `zona`,
`ciudad`, `precio_min`, `precio_max`, `ambientes` (mínimo), `dormitorios_min`,
`sort`, `page` y `limit` (default 5, máximo 20).

Nuevos filtros opcionales:

| Parámetro | Valores / significado |
|---|---|
| `zonas` | Hasta 10 zonas alternativas, separadas por coma o como parámetros repetidos. Se unen con `zona` por OR |
| `moneda` | `ARS`, `USD`; no hay conversión monetaria |
| `mascotas` | `se_permiten`, `no_se_permiten`, `sin_especificar` |
| `amoblado` | `amoblado`, `sin_amoblar`, `sin_especificar` |
| `dormitorios_max` | Entero >= 0, mayor o igual al mínimo |
| `ambientes_exactos` | Entero >= 0; no cambia la semántica mínima de `ambientes` |
| `excluir_ids` | Hasta 50 UUIDs, separados por coma o parámetros repetidos |
| `excluir_slugs` | Hasta 50 slugs reales, separados por coma o parámetros repetidos |

Desde 2026-08-31, tanto `zona` como los elementos de `zonas` aceptan alternativas
separadas por coma o por la conjunción `o`: `zona=Barrio Norte o Centro` busca
cualquiera de las dos. Se combinan ambos parámetros, se eliminan duplicados sin
distinción de acentos/mayúsculas y se valida un máximo total de 10 zonas.
`meta.filtros_aplicados.zonas` muestra la lista separada. No se interpreta `y`
ni se extraen ubicaciones de frases generales en `q`.

Equivalencia de inventario confirmada: para propiedades con ciudad
`San Miguel de Tucumán` (comparación sin acentos/mayúsculas), las etiquetas
completas `Barrio Norte`, `Norte` y `ZON NORTE` coinciden entre sí. No se amplía
a `Lomas del Norte`, `Zona Norte` ni otras variantes sin confirmar. Fuera de
esa ciudad, o cuando falta ciudad en la propiedad, se conserva la comparación
literal anterior sin expandir alias. El filtro de ciudad enviado sigue aplicando;
no se modifica la información almacenada ni se infiere ubicación desde títulos.

`q` busca todas las palabras normalizadas (sin acentos y con algunos alias de
tipos) sobre título, descripción, dirección, zona, ciudad, tipo y operación.
No es búsqueda semántica, por radio ni interpretación general de negaciones.
Las alturas numéricas se comparan como palabras: 660 no coincide con 6600.
Zonas/ciudad se comparan sin acentos. Tipo desconocido mantiene compatibilidad:
se ignora y se informa en `meta.advertencias`; el modelo no debe asumir que se aplicó.

Por defecto se conserva la inclusión de `disponible` y `privado`. La tool no
expone `estado` al modelo. Exclusiones se aplican antes de contar y paginar.
En `operacion=alquiler`, propiedades `ambos` filtran y ordenan por
`precio_alquiler`/`moneda_alquiler`, sin usar venta como reemplazo si faltan.
Sin moneda se mantienen los filtros numéricos por compatibilidad, con advertencia;
el orden por precio agrupa monedas, no compara ARS con USD. Expensas no se suman.

Respuesta: `{ data, meta }`. Cada propiedad agrega `precio_consulta` y
`moneda_consulta` según la operación, sin modificar `precio`/`moneda` existentes.
`meta` agrega `filtros_aplicados` y `advertencias` (array de strings).

### Identificar una referencia

`GET /agent/properties/identify?referencia=...`: string obligatorio, 1 a 500
caracteres. Acepta dirección/título, UUID, slug generado con prefijo de operación
y URL del dominio público configurado para el tenant. No descarga URLs.
Enlaces externos requieren otra referencia; no se leen redes sociales.

Respuesta 200: `{ resultado, propiedad, candidatos, total, motivo? }`.
`resultado`: `identificada`, `ambigua` o `no_identificada`. `propiedad` es null
salvo identificación; `candidatos` contiene hasta 5 propiedades públicas para
aclarar, no confirmaciones. `total` puede superar cinco. No filtra estado,
para reconocer una unidad vendida o reservada sin ofrecerla como disponible.
Si la altura no coincide, las referencias similares quedan ambiguas; nunca se
confirma automáticamente otra altura. Tampoco se elige una unidad si hay varias.

### Catálogo en contexto

`GET /agent/properties/catalog`: `{ tipos, ubicaciones: [{ ciudad, zona }] }`,
sin duplicados y del inventario disponible/privado del tenant. Campos de ubicación
pueden ser null. `tipos` es el enum admitido, no una garantía de stock por tipo.
El mismo objeto se agrega como `catalogo_propiedades` al endpoint existente
`GET /agent/conversations/:id/context`; n8n ya lo recibe sin una tool adicional.

El historial del contexto selecciona los últimos `k` mensajes ordenando por
`created_at DESC, id DESC`, y los devuelve cronológicamente. El ID desempata
mensajes del mismo instante antes de aplicar el límite; no se mezclan conversaciones.
La respuesta incluye además `mensajes_total`, el total real de mensajes de la
conversación sin aplicar `k`, para que los workflows ejecuten tareas periódicas
sin depender del tamaño de la ventana de contexto. `mensajes_desde_resumen`
cuenta los posteriores a `resumen_at` (o todos si todavía no hay resumen) y
permite actualizar la memoria cada diez mensajes aunque una respuesta se divida
en varios envíos.
La corrección de zonas y orden de 2026-08-31 no requiere nuevas migraciones,
variables ni cambios de workflow. No incluye cambios de prompt o de derivación.

Migración requerida: `20260830230000_agent_tenant_site_read`, lectura de la
configuración del propio tenant para construir/reconocer enlaces públicos.
No agrega columnas ni cambia asignaciones. Pruebas: `test/agent-search.test.ts`,
incluido RLS con dos tenants, contexto público y denegación de escritura.
