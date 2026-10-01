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
    const userTaken = await tx.user.findUnique({ where: { email: data.adminEmail } });
    if (userTaken) throw new ApiError("CONFLICT", "Ese email ya tiene una cuenta en Ubikka.");
    const pendingInvitation = await tx.invitation.findFirst({ where: {
      email: data.adminEmail, acceptedAt: null, expiresAt: { gt: new Date() }
    } });
    if (pendingInvitation) throw new ApiError("CONFLICT", "Ese email ya tiene una invitación pendiente.");

    const tenant = await tx.tenant.create({
      data: { nombre: data.nombre, slug: data.slug }
    });
    const invitation = await createInvitation(
      tx,
      { tenantId: tenant.id, invitedBy: auth.userId, email: data.adminEmail, rol: "admin" },
      tenant.nombre
    );
    return { tenant, devInvitationUrl: invitation.devInvitationUrl };
  });
}

export async function currentTenant(auth: AccessClaims) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: auth.tenantId! } });
    if (!tenant) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    return tenant;
  });
}

export async function resendTenantInvitation(auth: AccessClaims, tenantId: string) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId },
      include: { _count: { select: { users: true } } } });
    if (!tenant) throw new ApiError("NOT_FOUND", "La inmobiliaria no existe.");
    if (tenant.estado !== "activo" || tenant._count.users > 0) {
      throw new ApiError("CONFLICT", "La inmobiliaria ya tiene usuarios o está suspendida.");
    }
    const pending = await tx.invitation.findFirst({ where: { tenantId, acceptedAt: null },
      orderBy: { createdAt: "desc" } });
    if (!pending) throw new ApiError("NOT_FOUND", "No hay una invitación pendiente.");
    const invitation = await createInvitation(tx, { tenantId, invitedBy: auth.userId,
      email: pending.email, rol: "admin" }, tenant.nombre);
    return { email: invitation.email, devInvitationUrl: invitation.devInvitationUrl };
  });
}

export async function updateCurrentTenant(
  auth: AccessClaims,
  data: {
    logoUrl?: string | null;
    nombre?: string;
    configSitio?: { descripcion: string; telefono?: string; email?: string; direccion?: string; ciudad?: string; imagen_portada_url?: string; lema?: string; color_primario?: string };
    sitePublished?: boolean;
    agentConfig?: { model: string; instructions: string };
    agentEnabled?: boolean;
    followupEnabled?: boolean;
    followupFirstMessage?: string;
    followupSecondMessage?: string;
  }
) {
  if (config.NODE_ENV === "production" && data.agentEnabled === true &&
      !config.AGENT_CODE_TENANT_IDS.split(",").map((id) => id.trim()).includes(auth.tenantId ?? "")) {
    throw new ApiError("CONFLICT", "El agente estará disponible cuando finalice su migración a código.");
  }
  return runWithContext(ctxOf(auth), async (tx) => {
    const current = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId! },
      select: { configSitio: true, estado: true } });
    const previousConfig = current.configSitio && typeof current.configSitio === "object" &&
      !Array.isArray(current.configSitio) ? current.configSitio as Record<string, unknown> : {};
    const siteConfig = data.configSitio !== undefined
      ? { ...previousConfig, ...data.configSitio }
      : undefined;
    if (data.sitePublished === true) {
      const site = siteConfig ?? current.configSitio;
      if (current.estado !== "activo" || !site || typeof site !== "object" ||
          typeof (site as { descripcion?: unknown }).descripcion !== "string" ||
          (site as { descripcion: string }).descripcion.trim().length < 30) {
        throw new ApiError("CONFLICT", "Completá la descripción del sitio antes de publicarlo.");
      }
    }
    const tenant = await tx.tenant.update({
      where: { id: auth.tenantId! },
      data: {
        ...(data.logoUrl !== undefined ? { logoUrl: data.logoUrl } : {}),
        ...(data.nombre !== undefined ? { nombre: data.nombre } : {}),
        ...(siteConfig !== undefined
          ? { configSitio: siteConfig }
          : {}),
        ...(data.sitePublished !== undefined ? { sitePublished: data.sitePublished } : {}),
        ...(data.agentConfig !== undefined
          ? { agentConfig: data.agentConfig }
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
        data: { estado: "fallida", claimId: null, claimedAt: null }
      });
    }
    return tenant;
  });
}
