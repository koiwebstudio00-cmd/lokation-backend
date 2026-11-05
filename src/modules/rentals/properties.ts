import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { runWithContext } from "../../lib/prisma.js";
import { TIPOS } from "../../lib/property-opciones.js";
import { ApiError } from "../../lib/errors.js";

export const managedPropertyRoutes = Router();
managedPropertyRoutes.use("/rental-properties", requireAuth, requireRole("admin"));
const select = { id: true, titulo: true, direccion: true, tipo: true, estado: true, operacion: true, managed: true, administrationOnly: true } as const;
managedPropertyRoutes.get("/rental-properties", async (req, res) => {
  const query = z.object({ q: z.string().trim().max(160).default(""), page: z.coerce.number().int().min(1).max(100000).default(1),
    scope: z.enum(["managed", "eligible", "all"]).default("managed") }).parse(req.query);
  const result = await runWithContext(req.auth!, async tx => {
    const where = { tenantId: req.auth!.tenantId!, AND: [
      query.scope === "managed" ? { managed: true } : query.scope === "eligible" ? { OR: [{ managed: true }, { operacion: { in: ["alquiler", "ambos"] as ("alquiler" | "ambos")[] } }] } : {},
      query.q ? { OR: [{ titulo: { contains: query.q, mode: "insensitive" as const } }, { direccion: { contains: query.q, mode: "insensitive" as const } }] } : {}
    ] };
    const [data, total] = await Promise.all([tx.property.findMany({ where, select, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (query.page - 1) * 20, take: 20 }), tx.property.count({ where })]);
    return { data, meta: { total, page: query.page, limit: 20 } };
  });
  res.json(result);
});
managedPropertyRoutes.post("/rental-properties", async (req, res) => {
  const body = z.object({ titulo: z.string().trim().min(3).max(160), direccion: z.string().trim().min(3).max(300), tipo: z.enum(TIPOS) }).strict().parse(req.body);
  const auth = req.auth!;
  const property = await runWithContext(auth, tx => tx.property.create({ data: { ...body,
    tenantId: auth.tenantId!, userId: auth.userId, slug: `administracion-${randomUUID()}`,
    managed: true, administrationOnly: true, estado: "privado", operacion: "alquiler", precio: 0, moneda: "ARS"
  }, select }));
  res.status(201).json({ property });
});
managedPropertyRoutes.post("/rental-properties/:id/manage", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const property = await runWithContext(req.auth!, async tx => {
    const found = await tx.property.findUnique({ where: { id } });
    if (!found) throw new ApiError("NOT_FOUND", "La propiedad no existe.");
    return tx.property.update({ where: { id }, data: { managed: true }, select });
  });
  res.json({ property });
});
