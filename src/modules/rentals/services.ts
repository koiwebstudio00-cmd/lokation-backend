import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { runWithContext } from "../../lib/prisma.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import type { AccessClaims } from "../../lib/tokens.js";

export const rentalServiceRoutes = Router();
rentalServiceRoutes.use("/rental-properties", requireAuth, requireRole("admin"));

const uuid = z.string().uuid();
const accountFields = z.object({
  type: z.enum(["luz", "gas", "agua", "internet", "otro"]),
  provider: z.string().trim().min(1).max(120),
  account_number: z.string().trim().max(100).optional(),
  meter_number: z.string().trim().max(100).optional(),
  holder_name: z.string().trim().max(200).optional(),
  visibility: z.enum(["interna", "inquilino", "propietario", "ambos"]).default("interna")
}).strict().refine((data) => !!data.account_number || !!data.meter_number, {
  message: "Ingresá un número de cuenta o medidor."
});

function context(auth: AccessClaims) {
  if (!auth.tenantId) throw new ApiError("FORBIDDEN", "Se requiere una inmobiliaria.");
  return { tenantId: auth.tenantId, userId: auth.userId, rol: auth.rol };
}

rentalServiceRoutes.get("/rental-properties/:propertyId/services", async (req, res) => {
  const propertyId = uuid.parse(req.params.propertyId);
  const result = await runWithContext(context(req.auth!), async (tx) => {
    const property = await tx.property.findUnique({ where: { id: propertyId }, select: { id: true, operacion: true } });
    if (!property) throw new ApiError("NOT_FOUND", "La propiedad no existe.");
    const data = await tx.rentalServiceAccount.findMany({ where: { propertyId },
      orderBy: [{ active: "desc" }, { type: "asc" }, { createdAt: "desc" }] });
    return { data };
  });
  res.json(result);
});

rentalServiceRoutes.post("/rental-properties/:propertyId/services", async (req, res) => {
  const propertyId = uuid.parse(req.params.propertyId);
  const body = accountFields.parse(req.body);
  const auth = req.auth!;
  const account = await runWithContext(context(auth), async (tx) => {
    const property = await tx.property.findUnique({ where: { id: propertyId }, select: { operacion: true } });
    if (!property) throw new ApiError("NOT_FOUND", "La propiedad no existe.");
    if (property.operacion === "venta") throw new ApiError("VALIDATION_ERROR", "La propiedad no admite alquiler.");
    return tx.rentalServiceAccount.create({ data: {
      tenantId: auth.tenantId!, propertyId, createdById: auth.userId,
      type: body.type, provider: body.provider,
      accountNumber: body.account_number || null, meterNumber: body.meter_number || null,
      holderName: body.holder_name || null, visibility: body.visibility
    } });
  });
  res.status(201).json({ account });
});

rentalServiceRoutes.post("/rental-properties/:propertyId/services/:id/deactivate", async (req, res) => {
  const propertyId = uuid.parse(req.params.propertyId);
  const id = uuid.parse(req.params.id);
  const account = await runWithContext(context(req.auth!), async (tx) => {
    const { count } = await tx.rentalServiceAccount.updateMany({ where: { id, propertyId, active: true },
      data: { active: false, deactivatedAt: new Date() } });
    if (!count) throw new ApiError("NOT_FOUND", "El servicio activo no existe.");
    return tx.rentalServiceAccount.findUniqueOrThrow({ where: { id } });
  });
  res.json({ account });
});
