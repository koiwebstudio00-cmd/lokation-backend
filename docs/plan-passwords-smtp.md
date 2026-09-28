# Plan - Passwords administradas y correos SMTP

**Objetivo:** agregar soporte para que un `admin` o `super_admin` pueda cambiar la contrasena de otros usuarios desde la API, y completar el circuito de emails transaccionales: recuperacion, invitaciones, bienvenida y aviso de cambio de contrasena.

**Alcance:** backend API REST `/v1`, nodemailer/SMTP, documentacion y tests. No incluye UI del panel salvo que se planifique en el repo frontend.

## Estado actual

Ya existe:

- `POST /v1/users/me/password`: cambio de contrasena propia con `current_password`.
- `POST /v1/users/:id/password`: cambio administrado de contrasena para `admin`/`super_admin`, con revocacion de sesiones activas.
- `POST /v1/auth/forgot-password`: genera token y envia email de recuperacion.
- `POST /v1/auth/reset-password`: consume token y cambia la contrasena.
- `POST /v1/invitations`: envia correo de invitacion.
- `POST /v1/auth/accept-invitation`: crea usuario desde invitacion.
- `src/lib/mailer.ts`: servicio comun de correo con nodemailer. Si no hay `SMTP_HOST`, loguea en consola.

Falta:

- Configuracion SMTP real en el entorno de despliegue.
- Email de bienvenida con usuario y contrasena cuando corresponda crear/activar una cuenta sin flujo de invitacion.
- Guia operativa final de SMTP con smoke tests.

## Decisiones de producto y seguridad

1. El endpoint administrado no pide la contrasena actual del usuario afectado.
2. El backend hashea siempre la contrasena con bcrypt. Nunca se guarda ni se loguea en claro.
3. Si la contrasena fue generada por el operador/panel, solo puede existir en claro durante esa request para enviarla por email.
4. Despues de cambiar la contrasena se revocan los `refresh_tokens` activos del usuario afectado.
5. `admin` solo puede modificar usuarios de su propio tenant.
6. `super_admin` puede modificar usuarios de tenants.
7. Un `admin` no puede modificar usuarios `super_admin`.
8. Por defecto, un `super_admin` tampoco deberia cambiar la contrasena de otro `super_admin` desde este endpoint. Para bootstrap o emergencias se mantiene el CLI (`npm run admin -- set-password`).
9. La API debe devolver una respuesta generica de exito y no incluir la contrasena en la respuesta.
10. Todos los emails deben usar templates centralizados en `src/lib/mailer.ts` o helpers cercanos, no strings duplicados en services.

## Endpoint propuesto

### `POST /v1/users/:id/password`

Roles: `admin`, `super_admin`.

Headers:

- Cookie de sesion.
- `X-CSRF-Token`.

Body:

```json
{
  "new_password": "clave-segura-123",
  "notify": true
}
```

Campos:

- `new_password`: obligatorio, minimo 8 caracteres.
- `notify`: opcional, default `true`. Envia email al usuario con la contrasena temporal.

Respuesta:

```json
{
  "ok": true
}
```

Nota tecnica: hoy el modelo no tiene campo para forzar cambio de contrasena en el proximo login. Queda como mejora posterior con dos caminos:

- Implementacion minima: aceptar `force_change` pero dejarlo documentado como pendiente de modelo/UI.
- Implementacion completa: agregar columna `must_change_password boolean default false` en `users`, exponerla en `auth/me` y hacer que el panel obligue a pasar por cambio de contrasena.

Recomendacion: implementar la version completa si el panel va a poder bloquear navegacion hasta que cambie la clave. Si no, implementar el endpoint y el email primero, y dejar `must_change_password` para la iteracion de UI.

## Flujo: admin cambia contrasena

1. Admin entra al panel de equipo.
2. Admin elige usuario y define/genera una nueva contrasena.
3. Front llama `POST /v1/users/:id/password`.
4. Backend valida rol y tenant con fail-fast + RLS.
5. Backend hashea `new_password`.
6. Backend actualiza `users.password_hash`.
7. Backend revoca sesiones activas del usuario afectado.
8. Backend envia email:
   - asunto: `Tu contrasena fue actualizada`
   - incluye email/usuario, contrasena temporal y link al panel.
   - indica que debe cambiarla desde Perfil.
9. Backend responde `{ ok: true }`.

## Emails transaccionales requeridos

### 1. Recuperacion de contrasena

Trigger:

- `POST /v1/auth/forgot-password`

Contenido:

- Link con token: `${FRONT_URL}/actualizar-clave?token=...`
- Expiracion: 1 hora.
- Mensaje de seguridad: si no lo pidio, ignorar.

Estado: existe.

Mejora:

- Revisar texto final y subject.
- Agregar test/mock de `sendMail` si hoy no esta cubierto.

### 2. Admin cambio la contrasena del usuario

Trigger:

- `POST /v1/users/:id/password`

Contenido:

- Nombre del usuario.
- Email de acceso.
- Contrasena temporal.
- Link al panel: `${FRONT_URL}`.
- Indicacion clara: debe cambiarla desde Perfil al ingresar.

Estado: falta.

Consideracion:

- Enviar contrasenas por email no es ideal, pero es aceptable si se entiende como contrasena temporal y se fuerza/solicita cambio inmediato.
- Alternativa mas segura: enviar link de definicion de contrasena, igual que reset. Se puede decidir antes de implementar.

### 3. Correo de invitacion

Trigger:

- `POST /v1/invitations`
- `POST /v1/tenants`

Contenido:

- Nombre de la inmobiliaria.
- Link con token: `${FRONT_URL}/aceptar-invitacion?token=...`
- Expiracion: 7 dias.

Estado: existe.

Mejora:

- Revisar copy final.
- Confirmar que `FRONT_URL` apunta al panel real en produccion.

### 4. Correo de bienvenida con usuario y password

Trigger posible:

- Alta manual/importacion asistida de usuarios.
- Endpoint futuro de creacion directa de usuario.
- CLI administrativo cuando genere contrasena.

Contenido:

- Nombre.
- Email de acceso.
- Contrasena temporal.
- Link al panel.
- Instruccion de cambiar la contrasena al entrar.

Estado: falta como template y flujo HTTP.

Decision pendiente:

- Hoy el alta normal de equipo es por invitacion, donde el usuario define su contrasena. En ese flujo no corresponde enviar password.
- Este email aplica solo cuando Koi/admin crea o resetea una cuenta con una contrasena temporal.

## Configuracion SMTP

> **Estado (02/08/2026): HECHO.** Proveedor elegido **Resend**; configurado en producción (Dokploy) y envío verificado a inbox. SPF/DKIM operativos (los mails llegan a la casilla principal); queda por verificar explícitamente el `TXT _dmarc`.

Variables:

```env
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASS=<api-key-o-password-smtp>
EMAIL_FROM=Lamelas & Chaumont <no-reply@inmobiliarialyc.com.ar>
FRONT_URL=https://panel.inmobiliarialyc.com.ar
```

Proveedor en uso: **Resend** (`SMTP_HOST=smtp.resend.com`, `SMTP_USER=resend`, `SMTP_PASS=<api-key>`). Se evaluó también Hostinger Email; se descartó.

DNS obligatorio/recomendado:

- SPF del proveedor. ✅ operativo (mails a inbox).
- DKIM del proveedor. ✅ operativo (mails a inbox).
- DMARC basico recomendado. ⏳ verificar `TXT _dmarc` en la zona de Vercel DNS.

Smoke test:

1. Reiniciar backend con variables SMTP cargadas.
2. Ejecutar `POST /v1/auth/forgot-password` con un usuario real.
3. Crear una invitacion con `POST /v1/invitations`.
4. Crear un lead publico para confirmar notificacion al agente/admin.
5. Revisar inbox y spam.
6. Si cae en spam, revisar SPF/DKIM/DMARC y que `EMAIL_FROM` use un dominio validado.

## Implementacion backend

1. Agregar schema Zod en `src/modules/users/routes.ts`.
2. Agregar ruta `POST /users/:id/password` con `requireRole("admin", "super_admin")`.
3. Crear service `adminChangePassword(auth, userId, data)`.
4. Buscar usuario objetivo con `SAFE_SELECT` + `passwordHash` solo dentro del service.
5. Validar restricciones de rol:
   - target inexistente -> `NOT_FOUND`.
   - target `super_admin` -> `FORBIDDEN`.
   - admin de otro tenant -> `NOT_FOUND` o `FORBIDDEN`, manteniendo anti-enumeracion si conviene.
6. Actualizar `passwordHash`.
7. Revocar `refreshToken.updateMany({ where: { userId, revokedAt: null } })`.
8. Enviar email si `notify !== false`.
9. Agregar helper `adminPasswordChangedEmail(...)` en mailer.
10. Evaluar agregar `welcomeEmail(...)` aunque todavia no haya endpoint directo de alta.

## Tests

Casos minimos:

1. Admin cambia contrasena de agente del mismo tenant.
2. Login con password anterior falla.
3. Login con password nueva funciona.
4. Sesion previa del usuario afectado queda revocada.
5. Admin no cambia contrasena de usuario de otro tenant.
6. Agente no puede usar el endpoint.
7. Admin no puede cambiar contrasena de `super_admin`.
8. Super admin puede cambiar contrasena de usuario de tenant.
9. Body con password corta devuelve error Zod uniforme.

Si se agrega `must_change_password`:

10. El flag queda en `true` luego del cambio administrado.
11. El flag vuelve a `false` cuando el usuario cambia su propia contrasena.

## Documentacion a actualizar

- `docs/api-spec.md`: agregar `POST /users/:id/password`.
- `docs/onboarding.md`: aclarar cuando se usa invitacion vs bienvenida con password temporal.
- `.env.example`: completar ejemplo de `EMAIL_FROM` y notas SMTP si hace falta.
- `docs/deploy-runbook.md`: marcar smoke test SMTP con los cuatro emails.

## Verificacion final

Antes de cerrar la implementacion:

```bash
npm run lint
npx tsc --noEmit
npm run build
npm test
```

Si se toca RLS o acceso a datos, incluir suite con dos tenants.
