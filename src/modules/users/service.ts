import { ApiError } from "../../lib/errors.js";
import { adminPasswordChangedEmail, sendMail } from "../../lib/mailer.js";
import { hashPassword, verifyPassword } from "../../lib/passwords.js";
import { runWithContext } from "../../lib/prisma.js";
import type { AccessClaims } from "../../lib/tokens.js";
import { createInvitation } from "../auth/service.js";

const ctxOf = (a: AccessClaims) => ({
  userId: a.userId,
  tenantId: a.tenantId,
  rol: a.rol
});

const SAFE_SELECT = {
  id: true,
  nombre: true,
  email: true,
  rol: true,
  estado: true,
  tenantId: true,
  createdAt: true
} as const;

export async function listUsers(auth: AccessClaims, estado?: "activo" | "inactivo") {
  return runWithContext(ctxOf(auth), (tx) =>
    tx.user.findMany({
      where: estado ? { estado } : undefined,
      select: SAFE_SELECT,
      orderBy: { createdAt: "asc" }
    })
  );
}

export async function inviteUser(
  auth: AccessClaims,
  data: { email: string; rol: "admin" | "agente" }
) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: auth.tenantId! } });
    if (!tenant) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    const existing = await tx.user.findFirst({ where: { email: data.email } });
    if (existing) throw new ApiError("CONFLICT", "Ya existe una cuenta con ese email.");
    return createInvitation(
      tx,
      { tenantId: auth.tenantId!, invitedBy: auth.userId, email: data.email, rol: data.rol },
      tenant.nombre
    );
  });
}

export async function listInvitations(auth: AccessClaims) {
  return runWithContext(ctxOf(auth), (tx) =>
    tx.invitation.findMany({
      where: { acceptedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, rol: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: "desc" }
    })
  );
}

export async function revokeInvitation(auth: AccessClaims, id: string) {
  await runWithContext(ctxOf(auth), async (tx) => {
    const { count } = await tx.invitation.deleteMany({ where: { id } });
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
  });
}

export async function updateUser(
  auth: AccessClaims,
  id: string,
  data: { rol?: "admin" | "agente"; estado?: "activo" | "inactivo" }
) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const target = await tx.user.findUnique({ where: { id }, select: SAFE_SELECT });
    if (!target) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    if (target.rol === "super_admin") {
      throw new ApiError("FORBIDDEN", "No se puede modificar un super admin.");
    }

    // Protección "último admin": no dejar al tenant sin admins activos.
    const degrada = data.rol === "agente" || data.estado === "inactivo";
    if (target.rol === "admin" && degrada) {
      const otrosAdmins = await tx.user.count({
        where: { tenantId: target.tenantId, rol: "admin", estado: "activo", id: { not: id } }
      });
      if (otrosAdmins === 0) {
        throw new ApiError("CONFLICT", "No podés dejar la inmobiliaria sin admins activos.");
      }
    }

    return tx.user.update({ where: { id }, data, select: SAFE_SELECT });
  });
}

export async function updateMe(auth: AccessClaims, nombre: string) {
  return runWithContext(ctxOf(auth), (tx) =>
    tx.user.update({ where: { id: auth.userId }, data: { nombre }, select: SAFE_SELECT })
  );
}

export async function changePassword(
  auth: AccessClaims,
  currentPassword: string,
  newPassword: string
) {
  await runWithContext(ctxOf(auth), async (tx) => {
    const user = await tx.user.findUnique({ where: { id: auth.userId } });
    if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new ApiError("UNAUTHORIZED", "La contraseña actual es incorrecta.");
    }
    await tx.user.update({
      where: { id: auth.userId },
      data: { passwordHash: await hashPassword(newPassword) }
    });
  });
}

export async function adminChangePassword(
  auth: AccessClaims,
  id: string,
  data: { newPassword: string; notify: boolean }
) {
  await runWithContext(ctxOf(auth), async (tx) => {
    const target = await tx.user.findUnique({
      where: { id },
      select: { id: true, nombre: true, email: true, rol: true, tenantId: true }
    });
    if (!target) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    if (target.rol === "super_admin") {
      throw new ApiError("FORBIDDEN", "No se puede modificar un super admin.");
    }
    if (auth.rol === "admin" && target.tenantId !== auth.tenantId) {
      throw new ApiError("NOT_FOUND", "El recurso no existe.");
    }

    const { count } = await tx.user.updateMany({
      where: { id: target.id },
      data: { passwordHash: await hashPassword(data.newPassword) }
    });
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");

    await tx.refreshToken.updateMany({
      where: { userId: target.id, revokedAt: null },
      data: { revokedAt: new Date() }
    });

    if (data.notify) {
      await sendMail(adminPasswordChangedEmail(target.email, target.nombre, data.newPassword));
    }
  });
}
