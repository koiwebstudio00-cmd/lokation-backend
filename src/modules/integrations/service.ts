// Integraciones — credenciales de los sistemas externos que consumen la API.
//
// Vivía dentro de export/ cuando la única integración era el sitio público.
// Con el agente de IA hay dos consumidores con permisos distintos, así que la
// gestión de keys se separa y pasa a llevar scopes (lib/scopes.ts).
import { randomBytes } from "node:crypto";
import { ApiError } from "../../lib/errors.js";
import { runWithContext } from "../../lib/prisma.js";
import { DEFAULT_SCOPES, type ApiKeyScope } from "../../lib/scopes.js";
import { sha256, type AccessClaims } from "../../lib/tokens.js";
import * as repo from "./repo.js";

const ctxOf = (a: AccessClaims) => ({
  userId: a.userId,
  tenantId: a.tenantId,
  rol: a.rol
});

// Contexto interno para resolver la key: el lookup es por hash único y secreto,
// nunca derivado de otro input del request. Igual criterio que auth y worker.
const LOOKUP_CTX = { rol: "export" as const };

const KEY_PREFIX_LEN = 12;

export async function createApiKey(
  auth: AccessClaims,
  nombre: string,
  scopes: ApiKeyScope[] = DEFAULT_SCOPES
) {
  const key = `ilk_${randomBytes(24).toString("hex")}`;
  // Sin duplicados: el check de la BD valida los valores, no las repeticiones.
  const unicos = [...new Set(scopes)];
  const created = await runWithContext(ctxOf(auth), (tx) =>
    repo.insertApiKey(tx, {
      tenantId: auth.tenantId!,
      createdBy: auth.userId,
      nombre,
      keyHash: sha256(key),
      prefix: key.slice(0, KEY_PREFIX_LEN),
      scopes: unicos
    })
  );
  // La key completa se devuelve UNA sola vez; en BD queda solo el hash.
  return { apiKey: created, key };
}

export async function listApiKeys(auth: AccessClaims) {
  return runWithContext(ctxOf(auth), (tx) => repo.findActiveKeys(tx));
}

export async function revokeApiKey(auth: AccessClaims, id: string) {
  await runWithContext(ctxOf(auth), async (tx) => {
    const { count } = await repo.revokeKey(tx, id);
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
  });
}

export interface IntegrationContext {
  tenantId: string;
  keyId: string;
  scopes: ApiKeyScope[];
}

/**
 * Resuelve X-Api-Key → tenant + scopes. Lo consume middleware/apiKey.ts.
 * Distingue key inválida (401) de key válida sin permiso (403, en el
 * middleware): son problemas distintos para quien integra.
 */
export async function resolveApiKey(key: string): Promise<IntegrationContext> {
  const found = await runWithContext(LOOKUP_CTX, (tx) => repo.findKeyByHash(tx, sha256(key)));

  if (!found || found.revokedAt) {
    throw new ApiError("UNAUTHORIZED", "API key inválida o revocada.");
  }
  if (found.tenant.estado !== "activo") {
    throw new ApiError("FORBIDDEN", "La cuenta está suspendida.");
  }

  // Best-effort: si falla no bloquea ni voltea el request.
  void runWithContext(LOOKUP_CTX, (tx) => repo.touchLastUsed(tx, found.id)).catch(
    () => undefined
  );

  return {
    tenantId: found.tenantId,
    keyId: found.id,
    scopes: found.scopes as ApiKeyScope[]
  };
}
