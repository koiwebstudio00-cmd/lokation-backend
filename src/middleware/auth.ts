import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/errors.js";
import { ACCESS_COOKIE, CSRF_COOKIE } from "../lib/cookies.js";
import { verifyAccessToken, type AccessClaims } from "../lib/tokens.js";
import { runWithContext } from "../lib/prisma.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AccessClaims;
    }
  }
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Autentica por cookie httpOnly y aplica CSRF double-submit en mutations:
 * el header X-CSRF-Token debe coincidir con la cookie csrf_token.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[ACCESS_COOKIE] as string | undefined;
  if (!token) throw new ApiError("UNAUTHORIZED", "Sesión requerida.");

  try {
    req.auth = await verifyAccessToken(token);
  } catch {
    throw new ApiError("UNAUTHORIZED", "Sesión expirada o inválida.");
  }

  // El JWT puede seguir vigente después de suspender un tenant o desactivar
  // un usuario. Validamos su estado actual en cada request autenticado.
  const claims = req.auth;
  const user = await runWithContext({ rol: "auth" }, (tx) =>
    tx.user.findUnique({
      where: { id: claims.userId },
      select: { authVersion: true, deletedAt: true, estado: true, rol: true, tenantId: true, tenant: { select: { estado: true, authVersion: true } } }
    })
  );
  if (!user || user.deletedAt || user.authVersion !== (claims.userAuthVersion ?? 0) || user.estado !== "activo" || user.rol !== claims.rol ||
      (user.tenantId ?? undefined) !== claims.tenantId) {
    throw new ApiError("UNAUTHORIZED", "Sesión expirada o inválida.");
  }
  if (user.tenant?.estado === "suspendido") {
    throw new ApiError("FORBIDDEN", "La cuenta de la inmobiliaria está suspendida.");
  }
  if (user.tenant && user.tenant.authVersion !== claims.authVersion) {
    throw new ApiError("UNAUTHORIZED", "Sesión expirada o inválida.");
  }

  if (UNSAFE.has(req.method)) {
    const cookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
    const header = req.get("x-csrf-token");
    if (!cookie || !header || cookie !== header) {
      throw new ApiError("FORBIDDEN", "CSRF token inválido.");
    }
  }
  next();
}

/** Fail-fast de rol (UX). La garantía real es RLS. */
export function requireRole(...roles: AccessClaims["rol"][]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw new ApiError("UNAUTHORIZED", "Sesión requerida.");
    if (!roles.includes(req.auth.rol)) {
      throw new ApiError("FORBIDDEN", "No tenés permisos para esta acción.");
    }
    next();
  };
}
