import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export function mailConfigured(): boolean {
  return Boolean(config.RESEND_API_KEY || config.SMTP_HOST);
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

/** true significa que el proveedor aceptó el envío, no que llegó a la bandeja. */
export async function sendMail(mail: Mail): Promise<boolean> {
  try {
    if (config.RESEND_API_KEY) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: config.EMAIL_FROM, ...mail }),
        signal: AbortSignal.timeout(4000)
      });
      if (!response.ok) throw new Error("Resend rejected request");
      const data = await response.json() as { id?: string };
      if (!data.id) throw new Error("Missing message id");
      return true;
    }
    const t = transporter();
    if (!t) {
      console.info("[mail-dev] envío omitido: configurar RESEND_API_KEY y EMAIL_FROM.");
      return false;
    }
    await t.sendMail({ from: config.EMAIL_FROM, ...mail });
    return true;
  } catch {
    // No registrar tokens, destinatarios ni respuestas del proveedor.
    console.error("[mail] el proveedor no confirmó el envío");
    return false;
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
