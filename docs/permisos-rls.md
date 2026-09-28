# Matriz de Permisos y Políticas RLS

**Referencia:** `arquitectura.md` §4, `diagrama-er.md` · **Principio:** RLS es la autorización real; los checks en handlers son solo fail-fast/UX.

## 1. Contexto de sesión

Sin Supabase no existe `auth.uid()`. El middleware `tenant-context` abre una transacción por request y ejecuta:

```sql
SET LOCAL app.user_id = '<uuid del JWT>';
SET LOCAL app.tenant_id = '<uuid del JWT>';
SET LOCAL app.rol = 'agente';  -- super_admin | admin | agente
```

Helpers en la BD:

```sql
create function ctx_user_id() returns uuid language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create function ctx_tenant_id() returns uuid language sql stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;
create function ctx_rol() returns text language sql stable
  as $$ select current_setting('app.rol', true) $$;
create function is_super_admin() returns boolean language sql stable
  as $$ select ctx_rol() = 'super_admin' $$;
```

La API se conecta como rol `app_rt` (**sin** `BYPASSRLS`, sin `OWNER` de tablas). Requests públicos corren con contexto parcial: solo `app.tenant_id` y `app.rol = 'public'`. El tenant se resuelve según el caso: formulario web → `tenant_slug` en la URL; módulo export → API key (la key identifica al tenant).

## 2. Roles

| Rol | Ámbito | Descripción |
|---|---|---|
| `super_admin` | Plataforma (Koi Studio) | Gestión de tenants, planes, webhooks globales. No opera propiedades. |
| `admin` | Su tenant | Dueño de inmobiliaria: equipo, config del sitio, todo el inventario propio del tenant. |
| `agente` | Su tenant | Carga y gestiona sus propiedades; ve todo el inventario del tenant. |
| `public` | Formularios web y módulo export | Solo lectura de propiedades del tenant (sin campos internos) + alta de leads. El export usa este mismo rol con tenant fijado por API key. |

## 3. Matriz de permisos

✔ = permitido · ⚬ = solo recursos propios · ✖ = denegado

| Recurso / acción | super_admin | admin | agente | public |
|---|---|---|---|---|
| **tenants** ver | ✔ todos | ⚬ el suyo | ⚬ el suyo | ✖ |
| tenants crear / suspender | ✔ | ✖ | ✖ | ✖ |
| tenants editar config sitio/agente/seguimiento | ✔ | ⚬ | ✖ | ✖ |
| **users** listar (del tenant) | ✔ | ✔ | ✔ | ✖ |
| users invitar / cambiar rol / desactivar | ✔ | ✔ (no super_admin) | ✖ | ✖ |
| users editar perfil propio | ✔ | ⚬ | ⚬ | ✖ |
| **properties** ver (todas las del tenant) | ✔ | ✔ | ✔ | ✔ (sin campos internos, vía endpoints públicos) |
| properties crear (visible al instante, sin aprobación) | ✖ | ✔ | ✔ | ✖ |
| properties editar / eliminar | ✖ | ✔ (todas las del tenant) | ⚬ (las suyas) | ✖ |
| properties cambiar estado comercial | ✖ | ✔ | ⚬ | ✖ |
| **property_images** gestionar | ✖ | ✔ | ⚬ (de sus propiedades) | ✖ |
| **leads (CRM)** crear | ✖ | ✔ (manual) | ✔ (manual) | ✔ (formulario) |
| leads ver / gestionar | ✖ | ✔ | ⚬ (asignados o de sus propiedades) | ✖ |
| leads reasignar | ✖ | ✔ | ✖ | ✖ |
| **lead_notes** crear / ver | ✖ | ✔ | ⚬ (de sus leads) | ✖ |
| **api_keys (export)** gestionar | ✔ | ✔ | ✖ | ✖ |
| **webhook_endpoints** del tenant | ✔ | ✔ | ✖ | ✖ |
| webhook_endpoints globales | ✔ | ✖ | ✖ | ✖ |
| **channel_accounts** gestionar | ✔ | ✔ | ✖ | ✖ |
| **invitations** | ✔ | ✔ | ✖ | ✖ |

Notas:
- El admin edita cualquier propiedad de su tenant (cambio respecto del MVP, donde solo editaba el creador). El agente mantiene la regla del MVP: solo las suyas.
- `notas` sigue siendo interno: nunca se expone al rol `public` — ni en formularios ni en el módulo export (los endpoints públicos/export usan selects dedicados sin campos internos).

## 4. Políticas RLS (por tabla)

Patrón base — toda tabla de negocio combina: aislamiento por tenant + regla de rol. `FOR ALL` se separa por operación cuando las reglas difieren.

```sql
-- properties ---------------------------------------------------------------
alter table properties enable row level security;

-- Sin flujo de aprobación: 'public' ve todas las propiedades del tenant
-- (los campos internos se excluyen en los selects de los endpoints públicos).
create policy prop_select on properties for select using (
  is_super_admin()
  or (tenant_id = ctx_tenant_id() and ctx_rol() in ('admin','agente','public'))
);

create policy prop_insert on properties for insert with check (
  tenant_id = ctx_tenant_id()
  and user_id = ctx_user_id()
  and ctx_rol() in ('admin','agente')
);

create policy prop_update on properties for update using (
  tenant_id = ctx_tenant_id()
  and (ctx_rol() = 'admin' or (ctx_rol() = 'agente' and user_id = ctx_user_id()))
) with check (tenant_id = ctx_tenant_id());

create policy prop_delete on properties for delete using (
  tenant_id = ctx_tenant_id()
  and (ctx_rol() = 'admin' or (ctx_rol() = 'agente' and user_id = ctx_user_id()))
);
```

Resumen del resto (mismo patrón; SQL completo en la migración inicial):

| Tabla | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `tenants` | super_admin todos; miembros el suyo | super_admin | super_admin; admin solo `config_sitio`/`logo_url` del suyo (vía policy por columna o vista) | super_admin |
| `users` | super_admin; miembros del mismo tenant | super_admin; admin (rol ≠ super_admin, mismo tenant) | propio perfil; admin sobre su tenant (no puede tocar super_admins) | nadie (se usa `estado = inactivo`) |
| `invitations` | admin del tenant, super_admin | admin del tenant | admin del tenant (revocar) | admin del tenant |
| `property_images` | igual que `prop_select` (join por property) | admin, o agente dueño de la property | idem | idem |
| `leads` | admin del tenant; agente si está asignado, es de su property o está libre, excepto WhatsApp sin asignar mientras Sofía lo atiende; contextos internos `auth`/`agent` acotados al tenant | rol `public`/`auth` con `tenant_id = ctx_tenant_id()`; admin/agente (alta manual) | admin; agente asignado o sobre lead libre que no sea WhatsApp | admin |
| `lead_notes` | quien puede ver el lead | quien puede ver el lead | autor | admin |
| `api_keys` | admin del tenant, super_admin | admin del tenant | admin del tenant (desactivar) | admin del tenant |
| `webhook_endpoints` | super_admin; admin las del tenant | idem | idem | idem |
| `webhook_deliveries` | super_admin; admin las de sus endpoints | solo worker (rol interno) | solo worker | super_admin |
| `channel_accounts` | super_admin; admin del tenant; agent acotado a su tenant; worker para resolver cuenta → tenant | admin del tenant | admin del tenant | admin del tenant |
| `conversations` | según tenant/asignación; worker interno para eventos Zernio y vencimientos de seguimiento | agent/admin | agent/admin/vendedor autorizado; worker para intervención externa y claim/avance del seguimiento | nadie |
| `conversation_messages` | quien ve la conversación | agent/admin/vendedor autorizado; worker para `message.sent` externo | nadie | nadie |
| `handoffs` | quien ve la conversación; worker interno | agent | agent y worker | nadie |
| `refresh_tokens` / `password_resets` | **sin acceso para `app_rt` vía RLS de dueño propio** — solo el módulo auth con queries dedicadas (policy `user_id = ctx_user_id()` para revocación de sesiones propias) | — | — | — |

## 5. Publicación sin fricción

**No hay flujo de aprobación.** Decisión de producto (validada con el MVP de Lamelas): la propiedad queda visible en el sitio público desde el alta. No existen estados de publicación ni triggers de transición — el único estado es el comercial (`disponible|reservado|proximamente|pausado|vendida|alquilada`), que no restringe visibilidad (la web pública igual filtra `estado=disponible`).

## 6. Verificación (criterio de terminado)

El contexto interno `agent` (no el vendedor `agente`) tiene además lectura de
su propio registro de `tenants`, mediante `tenants_agent_select`
(`20260830230000_agent_tenant_site_read`). Se usa para `config_sitio.url_publica`
en herramientas de propiedades. No autoriza escritura, no amplía `public` y
exige `id = ctx_tenant_id()`. Los endpoints solo serializan el enlace resultante,
no la configuración completa. Cobertura: `test/agent-search.test.ts`.

Tests de integración obligatorios por tabla: (a) usuario de tenant B no ve/edita datos de tenant A; (b) agente no edita propiedad ajena de su propio tenant; (c) `public` nunca ve `notas` ni datos de usuarios; (d) admin no escala a super_admin. Ningún cambio de acceso se mergea sin su test.
