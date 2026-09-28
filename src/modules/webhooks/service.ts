import { ApiError } from "../../lib/errors.js";
import { runWithContext } from "../../lib/prisma.js";
import { randomToken } from "../../lib/tokens.js";
import type { AccessClaims } from "../../lib/tokens.js";

const ctxOf = (a: AccessClaims) => ({
  userId: a.userId,
  tenantId: a.tenantId,
  rol: a.rol
});

export const EVENTOS_VALIDOS = [
  "property.created",
  "property.updated",
  "property.estado_changed",
  "property.deleted",
  "lead.created",
  "lead.updated",
  "user.invited",
  "user.joined",
  "tenant.created",
  "tenant.suspended",
  "ping"
] as const;

/** Anti-SSRF básico: solo URLs https (http permitido únicamente en dev/test). */
export function validateWebhookUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError("VALIDATION_ERROR", "URL inválida.");
  }
  const devOk = process.env.NODE_ENV !== "production" && parsed.protocol === "http:";
  if (parsed.protocol !== "https:" && !devOk) {
    throw new ApiError("VALIDATION_ERROR", "La URL debe ser https.");
  }
  const host = parsed.hostname;
  if (
    process.env.NODE_ENV === "production" &&
    (host === "localhost" || /^127\.|^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\./.test(host))
  ) {
    throw new ApiError("VALIDATION_ERROR", "No se permiten URLs internas.");
  }
}

const SAFE_SELECT = {
  id: true,
  tenantId: true,
  url: true,
  eventos: true,
  activo: true,
  createdAt: true
} as const;

export async function listEndpoints(auth: AccessClaims) {
  return runWithContext(ctxOf(auth), (tx) =>
    tx.webhookEndpoint.findMany({ select: SAFE_SELECT, orderBy: { createdAt: "desc" } })
  );
}

export async function createEndpoint(
  auth: AccessClaims,
  data: { url: string; eventos: string[] }
) {
  validateWebhookUrl(data.url);
  return runWithContext(ctxOf(auth), async (tx) => {
    const secret = randomToken();
    const endpoint = await tx.webhookEndpoint.create({
      data: {
        // super_admin crea endpoints globales; admin, del tenant
        tenantId: auth.rol === "super_admin" ? null : auth.tenantId!,
        url: data.url,
        eventos: data.eventos,
        secret
      },
      select: SAFE_SELECT
    });
    // El secret se devuelve UNA sola vez.
    return { ...endpoint, secret };
  });
}

export async function updateEndpoint(
  auth: AccessClaims,
  id: string,
  data: { url?: string; eventos?: string[]; activo?: boolean; rotateSecret?: boolean }
) {
  if (data.url) validateWebhookUrl(data.url);
  return runWithContext(ctxOf(auth), async (tx) => {
    const secret = data.rotateSecret ? randomToken() : undefined;
    const { count } = await tx.webhookEndpoint.updateMany({
      where: { id },
      data: {
        ...(data.url ? { url: data.url } : {}),
        ...(data.eventos ? { eventos: data.eventos } : {}),
        ...(data.activo !== undefined ? { activo: data.activo } : {}),
        ...(secret ? { secret } : {})
      }
    });
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    const endpoint = await tx.webhookEndpoint.findUnique({ where: { id }, select: SAFE_SELECT });
    return secret ? { ...endpoint!, secret } : endpoint!;
  });
}

export async function deleteEndpoint(auth: AccessClaims, id: string) {
  await runWithContext(ctxOf(auth), async (tx) => {
    const { count } = await tx.webhookEndpoint.deleteMany({ where: { id } });
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
  });
}

export async function listDeliveries(auth: AccessClaims, endpointId: string) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const endpoint = await tx.webhookEndpoint.findUnique({ where: { id: endpointId } });
    if (!endpoint) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    return tx.webhookDelivery.findMany({
      where: { endpointId },
      orderBy: { createdAt: "desc" },
      take: 50
    });
  });
}

export async function sendTest(auth: AccessClaims, endpointId: string) {
  await runWithContext(ctxOf(auth), async (tx) => {
    const endpoint = await tx.webhookEndpoint.findUnique({ where: { id: endpointId } });
    if (!endpoint) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    // Delivery directa a este endpoint (sin filtro de suscripción).
    await tx.webhookDelivery.create({
      data: { endpointId, evento: "ping", payload: {} }
    });
  });
}
