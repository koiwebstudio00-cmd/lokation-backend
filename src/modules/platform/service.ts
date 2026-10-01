import { runWithContext } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
import { hashPassword } from "../../lib/passwords.js";
import type { AccessClaims } from "../../lib/tokens.js";
import { audit, revoke } from "./security.js";
const safe = { id: true, nombre: true, email: true, estado: true, createdAt: true } as const;
export async function listOperators(auth: AccessClaims) {
  return runWithContext(auth, (tx) => tx.user.findMany({ where: { rol: "super_admin", deletedAt: null }, select: safe, orderBy: { createdAt: "asc" } }));
}
export async function createOperator(auth: AccessClaims, data: { nombre: string; email: string; password: string }) {
  const passwordHash = await hashPassword(data.password);
  return runWithContext(auth, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(710011)`;
    if (await tx.user.findUnique({ where: { email: data.email } })) throw new ApiError("CONFLICT", "Ese email ya tiene una cuenta.");
    const user = await tx.user.create({ data: { nombre: data.nombre, email: data.email, passwordHash, rol: "super_admin" }, select: safe });
    await audit(tx, auth.userId, "operator.created", user.id);
    return user;
  });
}
export async function updateOperator(auth: AccessClaims, id: string, data: { nombre?: string; email?: string; estado?: "activo" | "inactivo" }, remove = false) {
  return runWithContext(auth, async (tx) => {
    // Serializa las bajas para proteger al último operador incluso con dos solicitudes simultáneas.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(710011)`;
    const target = await tx.user.findFirst({ where: { id, rol: "super_admin", deletedAt: null } });
    if (!target) throw new ApiError("NOT_FOUND", "Superadministrador no encontrado.");
    if (remove || data.estado === "inactivo") {
      if (id === auth.userId) throw new ApiError("CONFLICT", "No podés suspender ni eliminar tu propia cuenta.");
      if (!await tx.user.count({ where: { rol: "super_admin", estado: "activo", deletedAt: null, id: { not: id } } })) throw new ApiError("CONFLICT", "Debe quedar un superadministrador activo.");
    }
    if (data.email && await tx.user.findFirst({ where: { email: data.email, id: { not: id } } })) throw new ApiError("CONFLICT", "Ese email ya tiene una cuenta.");
    const user = await tx.user.update({ where: { id }, data: { ...data, ...(remove ? { deletedAt: new Date(), estado: "inactivo" as const } : {}) }, select: safe });
    if (remove || data.estado || data.email) await revoke(tx, id);
    await audit(tx, auth.userId, remove ? "operator.deleted" : "operator.updated", id);
    return user;
  });
}
export async function tenantDetail(auth: AccessClaims, id: string) {
  return runWithContext(auth, async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id }, select: {
      id: true, nombre: true, slug: true, estado: true, createdAt: true, sitePublished: true, logoUrl: true,
      agentEnabled: true, configSitio: true,
      _count: { select: { users: true, properties: true, leads: true, conversations: true } },
      users: { select: { ...safe, rol: true }, orderBy: { createdAt: "asc" } },
      invitations: { where: { acceptedAt: null }, select: { email: true, expiresAt: true } }
    } });
    if (!tenant) throw new ApiError("NOT_FOUND", "Inmobiliaria no encontrada.");
    const activity = await tx.platformAudit.findMany({ where: { targetId: id }, orderBy: { createdAt: "desc" }, take: 20 });
    return { ...tenant, activity };
  });
}
export async function statistics(auth: AccessClaims) {
  return runWithContext(auth, async (tx) => {
    const [tenants, users, properties, leads, conversations, propertyStates, leadStates, activity, growth] = await Promise.all([
      tx.tenant.findMany({ select: { id: true, nombre: true, slug: true, estado: true, sitePublished: true, createdAt: true,
        _count: { select: { users: true, properties: true, leads: true, conversations: true } } }, orderBy: { createdAt: "desc" } }),
      tx.user.count({ where: { rol: { not: "super_admin" }, deletedAt: null } }),
      tx.property.count(), tx.lead.count(), tx.conversation.count(),
      tx.property.groupBy({ by: ["estado"], _count: true }), tx.lead.groupBy({ by: ["estado"], _count: true }),
      tx.platformAudit.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
      tx.$queryRaw<{ month: string; tenants: number }[]>`SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'America/Argentina/Tucuman'), 'YYYY-MM') AS month, count(*)::int AS tenants FROM tenants WHERE created_at >= date_trunc('month', now()) - interval '11 months' GROUP BY 1 ORDER BY 1`
    ]);
    return { totals: { tenants: tenants.length, active: tenants.filter(t => t.estado === "activo").length,
      published: tenants.filter(t => t.estado === "activo" && t.sitePublished).length, users, properties, leads, conversations },
      tenants, propertyStates, leadStates, activity, growth, generatedAt: new Date().toISOString() };
  });
}
