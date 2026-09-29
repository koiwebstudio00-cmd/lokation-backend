import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { jwtSecret } from "../config.js";
import type { Rol } from "./prisma.js";

export const ACCESS_TTL = "15m";
export const REFRESH_TTL_DAYS = 30;
export const RESET_TTL_HOURS = 1;
export const INVITATION_TTL_DAYS = 7;

export interface AccessClaims {
  userId: string;
  tenantId?: string;
  authVersion?: number;
  rol: Exclude<Rol, "public" | "auth">;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return jwt.sign({ tenant_id: claims.tenantId ?? null, auth_version: claims.authVersion ?? null, rol: claims.rol }, jwtSecret, {
    subject: claims.userId,
    expiresIn: ACCESS_TTL,
    algorithm: "HS256"
  });
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const payload = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
  return {
    userId: payload.sub as string,
    tenantId: (payload.tenant_id as string | null) ?? undefined,
    authVersion: (payload.auth_version as number | null) ?? undefined,
    rol: payload.rol as AccessClaims["rol"]
  };
}

/** Token opaco para refresh/reset/invitación. Solo su hash va a la BD. */
export function randomToken(): string {
  return randomBytes(32).toString("hex");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function addDays(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export function addHours(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}
