import { ApiError } from "../../lib/errors.js";
import { config } from "../../config.js";
import { invitationEmail, resetEmail, sendMail } from "../../lib/mailer.js";
import { hashPassword, verifyPassword } from "../../lib/passwords.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import {
  addDays,
  addHours,
  INVITATION_TTL_DAYS,
  randomToken,
  REFRESH_TTL_DAYS,
  RESET_TTL_HOURS,
  sha256,
  signAccessToken,
  type AccessClaims
} from "../../lib/tokens.js";

// Contexto interno del módulo auth — ver migración 0002 y permisos-rls.md §1.
const AUTH_CTX = { rol: "auth" as const };

export interface SafeUser {
  id: string;
  nombre: string;
  email: string;
  rol: "super_admin" | "admin" | "agente";
  tenantId: string | null;
  tenant: { id: string; nombre: string; slug: string } | null;
}

export interface Session {
  user: SafeUser;
  access: string;
  refresh: string;
  csrf: string;
}

function toSafeUser(u: {
  id: string;
  nombre: string;
  email: string;
  rol: string;
  tenantId: string | null;
  tenant?: { id: string; nombre: string; slug: string } | null;
}): SafeUser {
  return {
    id: u.id,
    nombre: u.nombre,
    email: u.email,
    rol: u.rol as SafeUser["rol"],
    tenantId: u.tenantId,
    tenant: u.tenant ?? null
  };
}

async function createSession(
  tx: Tx,
  user: Parameters<typeof toSafeUser>[0],
  userAgent?: string
): Promise<Session> {
  const tenant = user.tenantId
    ? await tx.tenant.findUniqueOrThrow({
        where: { id: user.tenantId },
        select: { estado: true, authVersion: true }
      })
    : null;
  if (tenant?.estado === "suspendido") {
    throw new ApiError("FORBIDDEN", "La cuenta de la inmobiliaria está suspendida.");
  }
  const refresh = randomToken();
  await tx.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refresh),
      expiresAt: addDays(REFRESH_TTL_DAYS),
      userAgent: userAgent ?? null
    }
  });
  const access = await signAccessToken({
    userId: user.id,
    tenantId: user.tenantId ?? undefined,
    authVersion: tenant?.authVersion,
    rol: user.rol as AccessClaims["rol"]
  });
  return { user: toSafeUser(user), access, refresh, csrf: randomToken() };
}

const CREDENCIALES = new ApiError("UNAUTHORIZED", "Email o contraseña incorrectos.");

export async function login(
  email: string,
  password: string,
  userAgent?: string
): Promise<Session> {
  return runWithContext(AUTH_CTX, async (tx) => {
    const user = await tx.user.findFirst({
      where: { email, estado: "activo" },
      include: { tenant: { select: { id: true, nombre: true, slug: true, estado: true } } }
    });
    if (!user) throw CREDENCIALES;
    if (!(await verifyPassword(user.passwordHash, password))) throw CREDENCIALES;
    if (user.tenant && user.tenant.estado === "suspendido") {
      throw new ApiError("FORBIDDEN", "La cuenta de la inmobiliaria está suspendida.");
    }
    return createSession(tx, user, userAgent);
  });
}

export async function refresh(refreshToken: string, userAgent?: string): Promise<Session> {
  return runWithContext(AUTH_CTX, async (tx) => {
    const stored = await tx.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: {
        user: {
          include: { tenant: { select: { id: true, nombre: true, slug: true, estado: true } } }
        }
      }
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new ApiError("UNAUTHORIZED", "Sesión expirada o inválida.");
    }
    if (stored.user.estado !== "activo") {
      throw new ApiError("UNAUTHORIZED", "Usuario inactivo.");
    }
    if (stored.user.tenant?.estado === "suspendido") {
      throw new ApiError("FORBIDDEN", "La cuenta de la inmobiliaria está suspendida.");
    }
    // Rotación: el token usado queda revocado.
    await tx.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() }
    });
    return createSession(tx, stored.user, userAgent);
  });
}

export async function logout(refreshToken: string | undefined, all: boolean, userId: string) {
  await runWithContext(AUTH_CTX, async (tx) => {
    if (all) {
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
    } else if (refreshToken) {
      await tx.refreshToken.updateMany({
        where: { tokenHash: sha256(refreshToken), userId },
        data: { revokedAt: new Date() }
      });
    }
  });
}

export async function forgotPassword(email: string) {
  await runWithContext(AUTH_CTX, async (tx) => {
    const user = await tx.user.findFirst({ where: { email, estado: "activo" } });
    if (!user) return; // misma respuesta exista o no
    const token = randomToken();
    await tx.passwordReset.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt: addHours(RESET_TTL_HOURS) }
    });
    await sendMail(resetEmail(user.email, token));
  });
}

export async function resetPassword(token: string, password: string) {
  await runWithContext(AUTH_CTX, async (tx) => {
    const reset = await tx.passwordReset.findUnique({ where: { tokenHash: sha256(token) } });
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw new ApiError("UNAUTHORIZED", "El link expiró o ya fue usado.");
    }
    await tx.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } });
    await tx.user.update({
      where: { id: reset.userId },
      data: { passwordHash: await hashPassword(password) }
    });
    // Cierra todas las sesiones abiertas.
    await tx.refreshToken.updateMany({
      where: { userId: reset.userId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
  });
}

export async function acceptInvitation(
  token: string,
  nombre: string,
  password: string,
  userAgent?: string
): Promise<Session> {
  return runWithContext(AUTH_CTX, async (tx) => {
    const inv = await tx.invitation.findUnique({
      where: { tokenHash: sha256(token) },
      include: { tenant: { select: { id: true, nombre: true, slug: true } } }
    });
    if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) {
      throw new ApiError("UNAUTHORIZED", "La invitación expiró o ya fue usada.");
    }
    const existing = await tx.user.findUnique({ where: { email: inv.email } });
    if (existing) throw new ApiError("CONFLICT", "Ya existe una cuenta con ese email.");

    const user = await tx.user.create({
      data: {
        nombre,
        email: inv.email,
        passwordHash: await hashPassword(password),
        rol: inv.rol,
        tenantId: inv.tenantId
      }
    });
    await tx.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
    return createSession(tx, { ...user, tenant: inv.tenant }, userAgent);
  });
}

/** Crea una invitación + email. Reutilizado por tenants (alta) y users (equipo). */
export async function createInvitation(
  tx: Tx,
  data: { tenantId: string; invitedBy: string; email: string; rol: "admin" | "agente" },
  tenantNombre: string
) {
  const existing = await tx.invitation.findFirst({
    where: { tenantId: data.tenantId, email: data.email, acceptedAt: null }
  });
  if (existing) await tx.invitation.delete({ where: { id: existing.id } });

  const token = randomToken();
  const inv = await tx.invitation.create({
    data: {
      tenantId: data.tenantId,
      invitedBy: data.invitedBy,
      email: data.email,
      rol: data.rol,
      tokenHash: sha256(token),
      expiresAt: addDays(INVITATION_TTL_DAYS)
    }
  });
  const delivered = await sendMail(invitationEmail(data.email, token, tenantNombre));
  if (config.SMTP_HOST && !delivered) {
    throw new ApiError("INTERNAL", "No pudimos enviar la invitación. Probá de nuevo.");
  }
  return {
    ...inv,
    // En desarrollo sin SMTP, el operador necesita entregar el enlace de alta.
    devInvitationUrl: config.NODE_ENV !== "production" && !config.SMTP_HOST
      ? `${config.FRONT_URL}/aceptar-invitacion?token=${token}`
      : undefined
  };
}

export async function me(ctx: AccessClaims): Promise<SafeUser> {
  return runWithContext(
    { userId: ctx.userId, tenantId: ctx.tenantId, rol: ctx.rol },
    async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: ctx.userId },
        include: { tenant: { select: { id: true, nombre: true, slug: true } } }
      });
      if (!user) throw new ApiError("UNAUTHORIZED", "Sesión inválida.");
      return toSafeUser(user);
    }
  );
}
