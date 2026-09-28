# Onboarding — Alta de Inmobiliarias y Equipo

**Referencia:** `api-spec.md` §3–5, `permisos-rls.md`, `plan-mvp-backend.md`
**Estrategia:** manual-asistido en el MVP (las altas las hace Koi Studio); self-service queda diseñado pero se activa post-MVP. Sin registro abierto: **todo acceso nace de una invitación** (cierra el riesgo del PRD original).

## 1. Alta de inmobiliaria (tenant)

Flujo MVP (lo ejecuta el super admin):

1. `POST /tenants` con `{ nombre, slug, admin_email }`.
2. El sistema crea: tenant (`estado = activo`), invitación con rol `admin` a `admin_email`, evento `tenant.created`.
3. El dueño recibe email → `POST /auth/accept-invitation` con nombre y contraseña → queda logueado como admin de su tenant.
4. El `slug` queda reservado como identificador público del tenant (formularios y export; futuro sitio público).

Checklist operativo de Koi por alta: confirmar slug con el cliente · verificar que el email de invitación llegó · primera llamada de acompañamiento agendada.

## 2. Onboarding del admin (primer login)

Pantallas guiadas del front (el backend solo expone los endpoints):

1. **Perfil de la inmobiliaria** — logo, colores, datos de contacto (`PATCH /tenants/current`).
2. **Equipo** — invitar agentes (`POST /invitations`, rol `agente`; expiran a los 7 días, revocables).
3. **Primera propiedad** — alta rápida (4 campos) + fotos; el flujo de aprobación se explica acá (borrador → revisión → publicada).
4. **Integración con su sitio web (si tiene)** — generar API key del módulo export (`POST /api-keys`) y entregar la doc de `api-spec.md` §9 al desarrollador del cliente; opcionalmente configurar un webhook para sincronización.
5. **CRM** — mostrar dónde llegan las consultas del formulario web y cómo gestionarlas (estados, asignación, notas).

## 3. Onboarding de agentes

1. Admin invita por email con rol `agente`.
2. Agente acepta → define contraseña → cae en "Mis propiedades" vacío con CTA de alta rápida.
3. Sin verificación de email adicional (la invitación ya prueba posesión de la casilla).

Bajas: `PATCH /users/:id { estado: inactivo }` — conserva sus propiedades (reasignables por el admin editándolas), revoca sesiones activas.

## 4. Migración de Lamelas (tenant fundador)

Caso especial: Lamelas no pasa por invitaciones — sus usuarios ya existen en Supabase.

1. Crear tenant `lamelas` + importar `users` (sin password: hash incompatible con Supabase Auth).
2. Importar `properties` (todas con `publicacion = 'publicada'` para no interrumpir la operación actual) y `property_images` (fotos ya copiadas a R2).
3. Todos los usuarios se importan con rol `agente` y una contraseña aleatoria irrecuperable (decisión 2026-07-26). El super admin de Koi promueve después al designado por Lamelas: `npm run admin -- set-rol --email <email> --rol admin`. Cada vendedor define la suya por el flujo de reset; si el SMTP todavía no está configurado, el operador puede fijarla con `npm run admin -- set-password --email <email>`.
4. Validar con Lamelas: login de todos, inventario completo visible, fotos OK. Recién ahí, apagar Supabase.

## 5. Self-service (post-MVP, diseñado)

Cuando se active la etapa SaaS abierta: página "Creá tu inmobiliaria" → `POST /public/signup` crea tenant + admin en un paso con verificación de email → mismo onboarding §2. Requiere: anti-abuso (rate limit, captcha), facturación operativa (hoy fuera de alcance) y panel super admin con aprobación opcional. No construir nada de esto en el MVP; el modelo de datos ya lo soporta.

## 6. Métricas de onboarding (para saber si funciona)

- Tiempo alta de tenant → primera propiedad publicada (objetivo < 48 h).
- % de invitaciones aceptadas en 7 días (objetivo > 80%).
- % de tenants con ≥ 80% del inventario cargado en 2 semanas (métrica heredada del PRD de Lamelas).

## 7. Operación — CLI de administración

Tareas que no pasan por la API porque necesitan existir *antes* de que haya alguien con sesión, o porque son intervenciones de operador. Corre con `DATABASE_URL_MIGRATE` (bypassa RLS a propósito): nunca se expone por HTTP.

```
npm run admin -- list [--tenant <slug>]
npm run admin -- create-superadmin --email <email> [--nombre "..."] [--password <pass>]
npm run admin -- set-rol --email <email> --rol admin|agente
npm run admin -- set-password --email <email> [--password <pass>]
```

Sin `--password` genera una contraseña fuerte y la imprime una sola vez — preferible, porque así no queda en el historial del shell. `set-rol` replica la protección de "último admin" del endpoint `PATCH /users/:id`: no deja al tenant sin admins activos. En el VPS se corre desde la consola del contenedor de la API en Dokploy.
