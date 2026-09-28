# Diagrama ER — Plataforma Inmobiliaria (Backend VPS)

**Referencia:** `arquitectura.md` §4 · Convención: nombres de columnas de negocio en español (consistente con el MVP actual).

## Diagrama

```mermaid
erDiagram
    tenants ||--o{ users : "tiene"
    tenants ||--o{ properties : "tiene"
    tenants ||--o{ leads : "recibe"
    tenants ||--o{ invitations : "invita"
    tenants ||--o{ api_keys : "emite"
    tenants ||--o{ webhook_endpoints : "configura"
    tenants ||--o{ channel_accounts : "conecta"
    tenants ||--o{ conversations : "mantiene"
    leads ||--o{ conversations : "conversa"
    conversations ||--o{ conversation_messages : "contiene"
    conversations ||--o{ handoffs : "deriva"
    users ||--o{ handoffs : "recibe"
    users ||--o{ properties : "crea"
    users ||--o{ refresh_tokens : "sesiones"
    users ||--o{ password_resets : "solicita"
    users ||--o{ invitations : "emitida por"
    properties ||--o{ property_images : "fotos"
    properties o|--o{ leads : "consultas"
    users o|--o{ leads : "asignado a"
    leads ||--o{ lead_notes : "seguimiento"
    users ||--o{ lead_notes : "escribe"
    webhook_endpoints ||--o{ webhook_deliveries : "entregas"

    tenants {
        uuid id PK
        text nombre
        text slug UK "identificador público (export, futuro sitio)"
        text logo_url "nullable"
        jsonb config_sitio "colores, contacto"
        tenant_estado estado "activo|suspendido"
        boolean agente_activo "interruptor global de Sofía"
        boolean seguimiento_activo
        text seguimiento_mensaje_1
        text seguimiento_mensaje_2
        text zernio_profile_id "nullable: profile canonico en Zernio"
        timestamptz created_at
    }

    users {
        uuid id PK
        uuid tenant_id FK "null solo para super_admin"
        text nombre
        citext email UK
        text password_hash "bcrypt"
        user_rol rol "super_admin|admin|agente"
        user_estado estado "activo|inactivo"
        timestamptz created_at
    }

    invitations {
        uuid id PK
        uuid tenant_id FK
        uuid invited_by FK "users"
        citext email
        user_rol rol "admin|agente"
        text token_hash UK
        timestamptz expires_at
        timestamptz accepted_at "nullable"
    }

    refresh_tokens {
        uuid id PK
        uuid user_id FK
        text token_hash UK
        timestamptz expires_at
        timestamptz revoked_at "nullable"
        text user_agent
    }

    password_resets {
        uuid id PK
        uuid user_id FK
        text token_hash UK
        timestamptz expires_at
        timestamptz used_at "nullable"
    }

    api_keys {
        uuid id PK
        uuid tenant_id FK
        text nombre "ej: sitio web propio"
        text prefix "públicos primeros 8 chars, para identificar"
        text key_hash UK "sha256, nunca en claro"
        boolean activo
        timestamptz last_used_at "nullable"
        timestamptz created_at
    }

    properties {
        uuid id PK
        uuid tenant_id FK
        uuid user_id FK "agente creador"
        text titulo
        text descripcion "nullable"
        operacion_enum operacion "venta|alquiler"
        tipo_enum tipo "monoambiente|departamento|casa|duplex|local_comercial|oficina|galpon|estacionamiento|terreno|otro"
        numeric precio
        moneda_enum moneda "ARS|USD"
        text direccion "nullable"
        text zona "nullable"
        text ciudad "nullable"
        int ambientes "nullable"
        int dormitorios "nullable"
        int banios "nullable"
        numeric sup_cubierta "nullable"
        numeric sup_total "nullable"
        estado_enum estado "disponible|reservado|proximamente|pausado|vendida|alquilada"
        text notas "nullable, interno"
        text requisitos "nullable: requisitos de alquiler, público"
        destino_enum destino "nullable: vivienda|comercial|profesional|otro"
        plazo_contrato_enum plazo_contrato "nullable: meses_12|meses_18|meses_24|meses_36|otro"
        text plazo_otro "nullable: detalle si plazo=otro"
        ajuste_enum ajuste "nullable: trimestral|cuatrimestral|otro"
        text ajuste_otro "nullable: detalle si ajuste=otro"
        indice_ajuste_enum indice_ajuste "nullable: icl|ipc|fijo"
        numeric indice_fijo_pct "nullable: % si indice=fijo"
        text expensas "nullable: texto libre"
        mascotas_enum mascotas "nullable: se_permiten|no_se_permiten|sin_especificar"
        amoblado_enum amoblado "nullable: amoblado|sin_amoblar|sin_especificar"
        numeric lat "nullable: pin del mapa"
        numeric lng "nullable: pin del mapa"
        text link_maps "nullable: link de Google Maps"
        timestamptz created_at
        timestamptz updated_at
    }

    property_images {
        uuid id PK
        uuid tenant_id FK
        uuid property_id FK
        text r2_key "tenant/property/uuid.webp"
        text url
        boolean es_portada
        int orden
        timestamptz created_at
    }

    leads {
        uuid id PK
        uuid tenant_id FK
        uuid property_id FK "nullable: lead general sin propiedad"
        uuid assigned_to FK "users, nullable"
        lead_canal canal "web|whatsapp|instagram|messenger|manual"
        text canal_ref "nullable: id externo del canal (wa_id, ig user, etc.)"
        text nombre
        text email "nullable (canales de chat pueden no tenerlo)"
        text telefono "nullable"
        text mensaje
        lead_estado estado "nueva|en_contacto|ganada|perdida"
        lead_clasificacion clasificacion "nullable: potencial|fantasma (la pone el agente, la corrige el vendedor)"
        timestamptz tomado_at "nullable: primera atención"
        uuid tomado_por FK "nullable: usuario físico conocido"
        lead_tomado_origen tomado_origen "nullable: panel|whatsapp_business_app|sistema"
        timestamptz created_at
        timestamptz updated_at
    }

    lead_notes {
        uuid id PK
        uuid tenant_id FK
        uuid lead_id FK
        uuid user_id FK "autor"
        text nota
        timestamptz created_at
    }

    channel_accounts {
        uuid id PK
        uuid tenant_id FK
        text canal "whatsapp"
        text zernio_profile_id
        text zernio_account_id UK
        text display_name "nullable"
        text display_phone "nullable"
        text estado "activa|desconectada|error"
        text connection_mode "unknown|coexistence|cloud_api"
        uuid conectada_por FK "nullable"
        timestamptz disconnected_at "nullable"
        timestamptz created_at
        timestamptz updated_at
    }

    conversations {
        uuid id PK
        uuid tenant_id FK
        uuid lead_id FK
        uuid channel_account_id FK "nullable: cuenta Zernio"
        text provider_conversation_id "nullable: conversación Zernio"
        text canal_ref "contacto/BSUID o sesión web"
        conversacion_estado estado "bot|esperando_humano|humano|cerrada"
        smallint seguimiento_paso "0..3"
        timestamptz seguimiento_vencimiento "nullable"
        timestamptz seguimiento_reclamado_at "nullable: lease del worker"
        timestamptz ultimo_mensaje_lead_at "nullable"
    }

    conversation_messages {
        bigint id PK
        uuid conversation_id FK
        mensaje_rol rol "lead|agente_ia|vendedor|sistema"
        text provider_message_id "nullable; dedupe por conversación"
        text contenido
        jsonb meta
    }

    handoffs {
        uuid id PK
        uuid tenant_id FK
        uuid conversation_id FK
        uuid vendedor_id FK
        text motivo
        handoff_resultado resultado
        boolean reasignable
        timestamptz asignado_at
        timestamptz tomado_at "nullable"
    }

    webhook_endpoints {
        uuid id PK
        uuid tenant_id FK "null = global (super admin)"
        text url
        text_array eventos "property.published, lead.created, ..."
        text secret "firma HMAC"
        boolean activo
        timestamptz created_at
    }

    webhook_deliveries {
        uuid id PK
        uuid endpoint_id FK
        text evento
        jsonb payload
        int intentos
        int http_status "nullable"
        delivery_estado estado "pendiente|entregada|fallida"
        timestamptz next_retry_at "nullable"
        timestamptz created_at
    }
```

## Reglas del modelo

1. **`tenant_id` NOT NULL** en toda tabla de negocio (excepción: `users.tenant_id` nullable solo para super admins de Koi Studio; `webhook_endpoints.tenant_id` nullable para hooks globales de plataforma).
2. **Índices compuestos que empiezan por `tenant_id`:** `(tenant_id, created_at desc)` y `(tenant_id, estado)` en properties; `(tenant_id, estado)` y `(tenant_id, canal)` en leads; `(tenant_id, email)` en users; etc.
3. **Enums de Postgres** para todos los campos de estado (mismos valores que el MVP actual + los nuevos `user_rol`, `lead_canal`, `lead_estado`).
4. **Obligatorios de propiedad sin cambios:** solo `titulo`, `operacion`, `tipo`, `precio` (regla 6 del MVP). **Sin flujo de aprobación:** la propiedad es visible públicamente desde el alta (decisión de producto — sin fricción, igual que el MVP). Los campos de alquiler (`destino`, `plazo_contrato`, `ajuste`, `indice_ajuste`, `expensas`, `mascotas`, `amoblado`, `requisitos`) y de mapa (`lat`, `lng`, `link_maps`) son todos opcionales; `tipo` y `estado` se ampliaron (ver la entidad). Migración `20260814000000_property_alquiler`.
5. **Nunca se guardan tokens/keys en claro:** `invitations`, `refresh_tokens`, `password_resets` y `api_keys` almacenan hash (SHA-256). Las API keys muestran solo `prefix` después de la creación.
6. **CRM multicanal:** `web` y `manual` crean leads desde formularios/panel; WhatsApp entra mediante Zernio y Sofía. `instagram` y `messenger` existen en el enum de leads, pero todavía no tienen conector ni conversación implementada.
7. **`updated_at`** por trigger (reutilizar el del MVP). Borrado de propiedad → cascade a `property_images` + limpieza de objetos R2 (en el service, no en la BD). `leads.property_id` con `ON DELETE SET NULL` (el lead sobrevive a la propiedad).
8. **Compatibilidad de migración:** `properties` es la misma tabla del schema Supabase actual + `link_maps`; `property_images` agrega `tenant_id` y `r2_key` — el import de Lamelas es directo.
9. **Sin `subscriptions` ni `tenant_domains` por ahora** (billing y dominios custom fuera de alcance). Se agregan por migración cuando toque; nada del modelo actual las asume.
10. **Seguimiento durable:** el paso y vencimiento viven en `conversations`; el claim evita que dos réplicas procesen la misma etapa. Un handoff con `reasignable=false` queda fuera del timeout normal. Migración `20260914000000_whatsapp_followups`.
