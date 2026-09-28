import { Prisma } from "@prisma/client";
import type { Tx } from "../../lib/prisma.js";
import type { ApiKeyScope } from "../../lib/scopes.js";

/** Lo que se muestra en el panel. La key en claro nunca sale de acá. */
export const API_KEY_SELECT = {
  id: true,
  nombre: true,
  prefix: true,
  scopes: true,
  lastUsedAt: true,
  createdAt: true
} satisfies Prisma.ApiKeySelect;

export function insertApiKey(
  tx: Tx,
  data: {
    tenantId: string;
    createdBy: string;
    nombre: string;
    keyHash: string;
    prefix: string;
    scopes: ApiKeyScope[];
  }
) {
  return tx.apiKey.create({ data, select: API_KEY_SELECT });
}

export function findActiveKeys(tx: Tx) {
  return tx.apiKey.findMany({
    where: { revokedAt: null },
    select: API_KEY_SELECT,
    orderBy: { createdAt: "desc" }
  });
}

export function revokeKey(tx: Tx, id: string) {
  return tx.apiKey.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

/**
 * Lookup por hash para el middleware. Cross-tenant a propósito: todavía no hay
 * tenant fijado — lo aporta la key. Corre con el contexto interno 'export'.
 */
export function findKeyByHash(tx: Tx, keyHash: string) {
  return tx.apiKey.findUnique({
    where: { keyHash },
    select: {
      id: true,
      tenantId: true,
      scopes: true,
      revokedAt: true,
      tenant: { select: { estado: true } }
    }
  });
}

export function touchLastUsed(tx: Tx, id: string) {
  return tx.apiKey.updateMany({ where: { id }, data: { lastUsedAt: new Date() } });
}
