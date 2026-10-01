import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  SUPER_ADMIN_URL: z.string().url().default("http://localhost:3003"),
  SECURITY_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  JWT_SECRET: z.string().default(""),
  COOKIE_SECURE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // Orígenes del navegador autorizados, separados por coma. Vacío = reflejar
  // cualquiera, que solo es aceptable en desarrollo (ver el guard de abajo).
  CORS_ORIGIN: z.string().default(""),
  // 'none' es obligatorio si el panel vive en otro sitio que la API (por
  // ejemplo panel en vercel.app y API en tu dominio): con 'lax' el navegador
  // directamente no manda la cookie de sesión y el login no funciona.
  // 'none' exige COOKIE_SECURE=true, si no el navegador la descarta.
  COOKIE_SAMESITE: z.enum(["lax", "none", "strict"]).default("lax"),
  // Para compartir la cookie entre subdominios del dominio de Ubikka.
  // Vacío = solo el host que la emitió.
  COOKIE_DOMAIN: z.string().optional(),
  // URL del panel: los links de los emails (invitación/reset) apuntan ahí.
  // El panel corre en 3000 y la API en 3001, así que el default NO es PORT.
  FRONT_URL: z.string().default("http://localhost:3000"),
  // SMTP (nodemailer). Sin SMTP_HOST, los emails se loggean a consola (dev).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default("Plataforma <no-reply@localhost>"),
  // Cloudflare R2 (S3-compatible). Sin credenciales, presign/delete quedan en
  // modo stub local (dev/test sin R2 real).
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default("property-images-dev"),
  R2_PUBLIC_URL: z.string().optional(),
  // ── Agente de IA ───────────────────────────────────────────────────────────
  // Minutos HÁBILES que espera un handoff antes de reasignarse. La toma puede
  // registrarse desde el panel o desde un message.sent originado en WhatsApp
  // Business App. El margen de 60 min contempla contactos externos que el
  // backend no puede observar (por ejemplo, una llamada telefónica).
  HANDOFF_TIMEOUT_MIN: z.coerce.number().default(60),
  // Horario de atención (hora local). Fuera de esa ventana el reloj del
  // timeout se pausa: si no, los leads de la noche rebotarían por todo el
  // equipo antes de que alguien abra el celular.
  LABORAL_DESDE: z.coerce.number().min(0).max(23).default(9),
  LABORAL_HASTA: z.coerce.number().min(1).max(24).default(19),
  /** Días laborables, formato cron (0 = domingo). Default: lunes a viernes. */
  LABORAL_DIAS: z.string().default("1,2,3,4,5"),
  // Tucumán no tiene horario de verano: alcanza un offset fijo.
  TZ_OFFSET_HORAS: z.coerce.number().default(-3),
  // Fallback del link público que el agente le manda al lead, cuando el tenant
  // no tiene `config_sitio.url_publica` cargado.
  SITIO_PUBLICO_URL: z.string().default(""),
  // Servicio en código. El allowlist activa tenants uno por uno; el secreto
  // firma credenciales breves usadas sólo por endpoints agent:*.
  AGENT_SERVICE_URL: z.string().url().optional(),
  AGENT_SERVICE_SECRET: z.string().optional(),
  AGENT_CODE_TENANT_IDS: z.string().default(""),
  // ── Zernio (canales de mensajería) ──────────────────────────────────────────
  // Una sola key para el team de Zernio de Ubikka; nunca se expone al panel.
  ZERNIO_API_KEY: z.string().optional(),
  // Verifica X-Zernio-Signature en /webhooks/zernio. Sin ella, el endpoint
  // rechaza todo (falla cerrado: mejor no recibir mensajes que aceptarlos sin
  // poder validar el origen).
  ZERNIO_WEBHOOK_SECRET: z.string().optional(),
  // Base para armar el redirect_url del connect flow (URL del panel en cada
  // ambiente). Sin barra final.
  ZERNIO_REDIRECT_BASE_URL: z.string().default("http://localhost:3000"),
  // Webhook histórico de n8n para tenants fuera del piloto en código.
  // Producción Ubikka no permite configurarlo.
  N8N_WHATSAPP_WEBHOOK_URL: z.string().optional(),
  // Ventana de agrupado de ráfagas del worker de Zernio. Zernio manda un
  // webhook por mensaje; se espera este silencio antes de despachar la
  // conversación a n8n, para que el lead que escribe entrecortado reciba UNA
  // respuesta y no una por mensaje. Es latencia agregada antes de que Sofi
  // arranque: subirlo agrupa mejor y responde más lento.
  ZERNIO_BUFFER_MS: z.coerce.number().default(8000)
});

export const config = envSchema.parse(process.env);

if (config.AGENT_CODE_TENANT_IDS.trim()) {
  if (!config.AGENT_SERVICE_URL || !config.AGENT_SERVICE_SECRET || config.AGENT_SERVICE_SECRET.length < 32) {
    throw new Error("AGENT_SERVICE_URL y AGENT_SERVICE_SECRET (mínimo 32 caracteres) son obligatorios al activar tenants en código.");
  }
  if (config.NODE_ENV === "production" && !config.AGENT_SERVICE_URL.startsWith("https://")) {
    throw new Error("AGENT_SERVICE_URL debe usar HTTPS en producción.");
  }
}

if (config.NODE_ENV === "production") {
  if (!config.SUPER_ADMIN_URL.startsWith("https://")) throw new Error("SUPER_ADMIN_URL debe usar HTTPS en producción.");
  if (!config.JWT_SECRET) {
    throw new Error("JWT_SECRET es obligatorio en producción (openssl rand -hex 32).");
  }
  // Sin allowlist, cors({ origin: true }) refleja el Origin de quien pregunte y
  // con credentials:true eso deja que cualquier sitio haga requests
  // autenticados con la cookie del usuario. El CSRF cubre las mutaciones, no
  // las lecturas. Preferimos no arrancar antes que arrancar así.
  if (!config.CORS_ORIGIN) {
    throw new Error(
      "CORS_ORIGIN es obligatorio en producción: lista separada por comas de los orígenes del panel y del sitio."
    );
  }
  if (!config.COOKIE_SECURE) {
    throw new Error("COOKIE_SECURE debe ser 'true' en producción (las cookies viajan por HTTPS).");
  }
  if (!config.SMTP_HOST || config.EMAIL_FROM.includes("@localhost")) {
    throw new Error("SMTP_HOST y EMAIL_FROM propio son obligatorios en producción.");
  }
  if (!config.FRONT_URL.startsWith("https://")) {
    throw new Error("FRONT_URL debe usar HTTPS en producción para los enlaces de acceso.");
  }
  if (config.N8N_WHATSAPP_WEBHOOK_URL) {
    throw new Error("El workflow n8n heredado no puede usarse en producción de Ubikka.");
  }
}

// El navegador descarta SameSite=None sin Secure: fallaría en silencio y el
// síntoma sería "el login no persiste", que es carísimo de diagnosticar.
if (config.COOKIE_SAMESITE === "none" && !config.COOKIE_SECURE) {
  throw new Error("COOKIE_SAMESITE=none requiere COOKIE_SECURE=true.");
}

/** Orígenes permitidos, ya parseados. Vacío = reflejar (solo dev). */
export const corsOrigins: string[] = config.CORS_ORIGIN.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Solo dev/test: secret fijo para no frenar el arranque local.
export const jwtSecret =
  config.JWT_SECRET || "dev-secret-no-usar-en-produccion-0123456789abcdef";
