import { ApiError } from "../../lib/errors.js";
import { config } from "../../config.js";
import { runWithContext } from "../../lib/prisma.js";
import type { AccessClaims } from "../../lib/tokens.js";
import { createInvitation } from "../auth/service.js";

const ctxOf = (a: AccessClaims) => ({
  userId: a.userId,
  tenantId: a.tenantId,
  rol: a.rol
});

export async function listTenants(auth: AccessClaims) {
  return runWithContext(ctxOf(auth), (tx) =>
    tx.tenant.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { users: true } } }
    })
  );
}

export async function createTenant(
  auth: AccessClaims,
  data: { nombre: string; slug: string; adminEmail: string }
) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const slugTaken = await tx.tenant.findUnique({ where: { slug: data.slug } });
    if (slugTaken) throw new ApiError("CONFLICT", "Ese slug ya está en uso.");

    const tenant = await tx.tenant.create({
      data: { nombre: data.nombre, slug: data.slug }
    });
    await createInvitation(
      tx,
      { tenantId: tenant.id, invitedBy: auth.userId, email: data.adminEmail, rol: "admin" },
      tenant.nombre
    );
    return tenant;
  });
}

export async function currentTenant(auth: AccessClaims) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: auth.tenantId! } });
    if (!tenant) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    return tenant;
  });
}

export async function updateCurrentTenant(
  auth: AccessClaims,
  data: {
    logoUrl?: string | null;
    configSitio?: unknown;
    agentEnabled?: boolean;
    followupEnabled?: boolean;
    followupFirstMessage?: string;
    followupSecondMessage?: string;
  }
) {
  if (config.NODE_ENV === "production" && data.agentEnabled === true) {
    throw new ApiError("CONFLICT", "El agente estará disponible cuando finalice su migración a código.");
  }
  return runWithContext(ctxOf(auth), async (tx) => {
    const tenant = await tx.tenant.update({
      where: { id: auth.tenantId! },
      data: {
        ...(data.logoUrl !== undefined ? { logoUrl: data.logoUrl } : {}),
        ...(data.configSitio !== undefined
          ? { configSitio: data.configSitio as object }
          : {}),
        ...(data.agentEnabled !== undefined
          ? { agentEnabled: data.agentEnabled }
          : {}),
        ...(data.followupEnabled !== undefined
          ? { followupEnabled: data.followupEnabled }
          : {}),
        ...(data.followupFirstMessage !== undefined
          ? { followupFirstMessage: data.followupFirstMessage }
          : {}),
        ...(data.followupSecondMessage !== undefined
          ? { followupSecondMessage: data.followupSecondMessage }
          : {})
      }
    });

    if (data.agentEnabled === false) {
      await tx.conversation.updateMany({
        where: { tenantId: auth.tenantId!, estado: "bot" },
        data: {
          followupStep: 0,
          followupDueAt: null,
          followupClaimedAt: null
        }
      });
    }
    return tenant;
  });
}

export async function setTenantEstado(
  auth: AccessClaims,
  id: string,
  estado: "activo" | "suspendido"
) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const tenant = await tx.tenant.update({
      where: { id },
      data: { estado, ...(estado === "suspendido" ? { authVersion: { increment: 1 } } : {}) }
    });
    if (estado === "suspendido") {
      const users = await tx.user.findMany({ where: { tenantId: id }, select: { id: true } });
      await tx.refreshToken.updateMany({
        where: { userId: { in: users.map((user) => user.id) }, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      await tx.conversation.updateMany({
        where: { tenantId: id, followupStep: { gt: 0 } },
        data: { followupStep: 0, followupDueAt: null, followupClaimedAt: null }
      });
      const endpoints = await tx.webhookEndpoint.findMany({
        where: { tenantId: id }, select: { id: true }
      });
      await tx.webhookDelivery.updateMany({
        where: { endpointId: { in: endpoints.map((endpoint) => endpoint.id) }, estado: "pendiente" },
        data: { estado: "fallida" }
      });
    }
    return tenant;
  });
}
