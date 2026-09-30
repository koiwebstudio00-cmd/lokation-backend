import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { ApiError } from "./errors.js";
import { runWithContext } from "./prisma.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AGE_SECONDS = 300;

function secret() {
  if (!config.AGENT_SERVICE_SECRET || config.AGENT_SERVICE_SECRET.length < 32) {
    throw new ApiError("UNAUTHORIZED", "Servicio del agente no configurado.");
  }
  return config.AGENT_SERVICE_SECRET;
}

/** Credencial de cinco minutos; se entrega al servicio y éste la reenvía a la API. */
export function signAgentServiceToken(tenantId: string, now = Date.now()) {
  if (!UUID.test(tenantId)) throw new Error("tenantId inválido");
  const payload = Buffer.from(JSON.stringify({
    aud: "ubikka-agent", sub: tenantId, exp: Math.floor(now / 1000) + MAX_AGE_SECONDS
  })).toString("base64url");
  const signature = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export async function resolveAgentServiceToken(token: string) {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new ApiError("UNAUTHORIZED", "Token interno inválido.");
  const expected = Buffer.from(createHmac("sha256", secret()).update(parts[0]).digest("base64url"));
  const actual = Buffer.from(parts[1]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ApiError("UNAUTHORIZED", "Token interno inválido.");
  }
  let claims: { aud?: unknown; sub?: unknown; exp?: unknown };
  try { claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
  catch { throw new ApiError("UNAUTHORIZED", "Token interno inválido."); }
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== "ubikka-agent" || typeof claims.sub !== "string" || !UUID.test(claims.sub) ||
      typeof claims.exp !== "number" || claims.exp <= now || claims.exp > now + MAX_AGE_SECONDS) {
    throw new ApiError("UNAUTHORIZED", "Token interno vencido o inválido.");
  }
  if (config.NODE_ENV === "production" &&
      !config.AGENT_CODE_TENANT_IDS.split(",").map((id) => id.trim()).includes(claims.sub)) {
    throw new ApiError("FORBIDDEN", "Inmobiliaria fuera del piloto del agente.");
  }
  const tenant = await runWithContext({ rol: "auth" }, (tx) =>
    tx.tenant.findUnique({ where: { id: claims.sub as string }, select: { estado: true } })
  );
  if (tenant?.estado !== "activo") throw new ApiError("FORBIDDEN", "La cuenta está suspendida.");
  return { tenantId: claims.sub, keyId: `agent-service:${claims.sub}`,
    scopes: ["agent:read", "agent:write"] as const };
}
