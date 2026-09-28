# 500 al crear consulta web: SMTP dentro de la transacción (P2028)

- **Detectado:** 2026-08-13 (probando el alta desde la web; visible en logs de la API)
- **Estado:** implementado 2026-08-13 · **en `origin/main`, desplegado** (verificado 2026-09-27)
- **Repo afectado:** `back-lamelas`

## Síntoma

Al enviar una consulta desde el sitio, la web muestra "Error interno del servidor",
la API loguea un 500 y **el mail SÍ llega** (Resend lo envía), pero el lead **no queda**
en la base.

Logs relevantes:
```
POST /v1/public/lamelas-chaumont/leads  -> 500
PrismaClientKnownRequestError P2028: Transaction already closed: A commit cannot be
executed on an expired transaction. The timeout for this transaction was 5000 ms,
however 8160 ms passed since the start of the transaction.
  at dist/modules/crm/routes.js:33  (createPublicLead)
```
(También aparece, como ruido, un `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` de express-rate-limit.)

## Causa raíz

En `crm/service.ts createPublicLead`, el aviso por email (`notifyLead` → `sendMail`,
SMTP a Resend) corría **dentro** de la transacción interactiva de Prisma. El handshake
SMTP en frío tardó ~8 s, superó el timeout de la transacción (5 s por defecto), la tx
expiró (P2028) y el `commit` falló → el `lead.create` se revirtió. Pero `sendMail` ya
había disparado el envío por red, así que el correo salió igual.

Es un caso de red bloqueante adentro de una tx: viola la idea de la regla #8 del proyecto
(en la tx solo trabajo de negocio; los efectos externos, afuera). `sendMail` traga sus
errores, pero **el tiempo** que tarda igual cuenta contra el timeout de la tx.

Nota: probablemente explique parte de las consultas "perdidas" además del filtro del panel
(otro bug): las que se enviaban justo después de un redeploy (SMTP en frío) daban 500.

## Solución implementada

Separar en `createPublicLead`:
- **Dentro de la tx** (solo BD, rápido): lookup de propiedad, `lead.create`, `emit_event`
  y resolver destinatarios (`leadRecipients`). La tx devuelve `{ lead, recipients }`.
- **Fuera de la tx** (red, puede tardar): `sendLeadEmails(recipients, lead)`. Si el mail
  falla o tarda, el lead ya está commiteado y el usuario recibe 201.

Además: `app.set("trust proxy", 1)` en `app.ts` — detrás de Traefik/Dokploy, sin esto
express-rate-limit tira el ValidationError de X-Forwarded-For y toma la IP equivocada.

Archivos: `src/modules/crm/service.ts`, `src/app.ts`.

## Verificación
- `tsc --noEmit`, `eslint`, `build` OK.
- Manual tras deploy: enviar una consulta desde la web → 201, el lead aparece en `/consultas`
  y el mail llega. Ya no debería haber P2028 ni el warning de X-Forwarded-For.
