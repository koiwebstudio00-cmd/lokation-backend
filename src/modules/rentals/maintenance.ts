import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { runWithContext } from "../../lib/prisma.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import type { AccessClaims } from "../../lib/tokens.js";

export const maintenanceRoutes = Router();
maintenanceRoutes.use("/maintenance-requests", requireAuth, requireRole("admin"));

const uuid = z.string().uuid();
const createSchema = z.object({
  property_id: uuid,
  contract_id: uuid.optional(),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(5000),
  priority: z.enum(["baja", "normal", "alta", "urgente"]).default("normal"),
  note: z.string().trim().min(5).max(2000)
}).strict();
const transitionSchema = z.object({
  status: z.enum(["en_gestion", "resuelta", "cancelada"]),
  note: z.string().trim().min(5).max(2000)
}).strict();
const listSchema = z.object({
  property_id: uuid.optional(),
  status: z.enum(["abierta", "en_gestion", "resuelta", "cancelada"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24)
});

function context(auth: AccessClaims) {
  if (!auth.tenantId) throw new ApiError("FORBIDDEN", "Se requiere una inmobiliaria.");
  return { tenantId: auth.tenantId, userId: auth.userId, rol: auth.rol };
}

maintenanceRoutes.get("/maintenance-requests", async (req, res) => {
  const query = listSchema.parse(req.query);
  const result = await runWithContext(context(req.auth!), async (tx) => {
    const where = { ...(query.property_id ? { propertyId: query.property_id } : {}),
      ...(query.status ? { status: query.status } : {}) };
    const [data, total] = await Promise.all([
      tx.maintenanceRequest.findMany({ where, include: { property: { select: { titulo: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.limit, take: query.limit }),
      tx.maintenanceRequest.count({ where })
    ]);
    return { data, meta: { page: query.page, limit: query.limit, total } };
  });
  res.json(result);
});

maintenanceRoutes.post("/maintenance-requests", async (req, res) => {
  const body = createSchema.parse(req.body);
  const auth = req.auth!;
  const item = await runWithContext(context(auth), async (tx) => {
    const property = await tx.property.findUnique({ where: { id: body.property_id }, select: { id: true, operacion: true } });
    if (!property) throw new ApiError("NOT_FOUND", "La propiedad no existe.");
    if (property.operacion === "venta") throw new ApiError("VALIDATION_ERROR", "La propiedad no admite alquiler.");
    if (body.contract_id) {
      const contract = await tx.rentalContract.findUnique({ where: { id: body.contract_id },
        select: { propertyId: true, status: true } });
      if (!contract || contract.propertyId !== property.id) throw new ApiError("NOT_FOUND", "El contrato no corresponde a la propiedad.");
    }
    const created = await tx.maintenanceRequest.create({ data: {
      tenantId: auth.tenantId!, propertyId: property.id, contractId: body.contract_id,
      createdById: auth.userId, title: body.title, description: body.description,
      priority: body.priority
    } });
    await tx.maintenanceEvent.create({ data: { tenantId: auth.tenantId!, requestId: created.id,
      actorId: auth.userId, toState: "abierta", note: body.note } });
    return tx.maintenanceRequest.findUniqueOrThrow({ where: { id: created.id }, include: { events: true } });
  });
  res.status(201).json({ item });
});

maintenanceRoutes.get("/maintenance-requests/:id", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const item = await runWithContext(context(req.auth!), (tx) => tx.maintenanceRequest.findUnique({
    where: { id }, include: { property: { select: { id: true, titulo: true } },
      events: { orderBy: { createdAt: "desc" }, take: 100 } }
  }));
  if (!item) throw new ApiError("NOT_FOUND", "El pedido no existe.");
  res.json({ item });
});

maintenanceRoutes.post("/maintenance-requests/:id/transition", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = transitionSchema.parse(req.body);
  const auth = req.auth!;
  const item = await runWithContext(context(auth), async (tx) => {
    const current = await tx.maintenanceRequest.findUnique({ where: { id } });
    if (!current) throw new ApiError("NOT_FOUND", "El pedido no existe.");
    if (["resuelta", "cancelada"].includes(current.status)) throw new ApiError("CONFLICT", "El pedido ya está cerrado.");
    if (current.status === body.status || current.status === "abierta" && body.status === "resuelta") {
      throw new ApiError("CONFLICT", "El cambio de estado no es válido.");
    }
    const updated = await tx.maintenanceRequest.update({ where: { id }, data: {
      status: body.status, resolvedAt: body.status === "resuelta" ? new Date() : null
    } });
    await tx.maintenanceEvent.create({ data: {
      tenantId: auth.tenantId!, requestId: id, actorId: auth.userId,
      fromState: current.status, toState: body.status, note: body.note
    } });
    return updated;
  });
  res.json({ item });
});
