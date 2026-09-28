import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

let _transporter: Transporter | null = null;

function transporter(): Transporter | null {
  if (!config.SMTP_HOST) return null;
  _transporter ??= nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth:
      config.SMTP_USER && config.SMTP_PASS
        ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
        : undefined
  });
  return _transporter;
}

/**
 * Envío por SMTP (nodemailer) si hay SMTP_HOST; si no (dev), loggea a consola.
 * Los emails nunca frenan el flujo: errores se loggean y se sigue.
 */
export async function sendMail(mail: Mail): Promise<void> {
  const t = transporter();
  if (!t) {
    console.log(`[mail-dev] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
    return;
  }
  try {
    await t.sendMail({ from: config.EMAIL_FROM, ...mail });
  } catch (err) {
    console.error("[mail] error enviando email:", err);
  }
}

export function invitationEmail(to: string, token: string, tenantNombre: string): Mail {
  return {
    to,
    subject: `Invitación a ${tenantNombre}`,
    text: `Te invitaron a sumarte a ${tenantNombre}.\n\nAceptá la invitación acá (vence en 7 días):\n${config.FRONT_URL}/aceptar-invitacion?token=${token}`
  };
}

export function resetEmail(to: string, token: string): Mail {
  return {
    to,
    subject: "Restablecer tu contraseña",
    text: `Para definir una nueva contraseña entrá acá (vence en 1 hora):\n${config.FRONT_URL}/actualizar-clave?token=${token}\n\nSi no lo pediste, ignorá este email.`
  };
}

export function adminPasswordChangedEmail(
  to: string,
  nombre: string,
  temporaryPassword: string
): Mail {
  return {
    to,
    subject: "Tu contraseña fue actualizada",
    text: `Hola ${nombre},\n\nUn administrador actualizó tu contraseña de acceso.\n\nUsuario: ${to}\nContraseña temporal: ${temporaryPassword}\n\nIngresá al panel y cambiala desde tu perfil:\n${config.FRONT_URL}\n\nSi no esperabas este cambio, avisale al administrador de tu inmobiliaria.`
  };
}
