import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { runWithContext } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";

export const taskRoutes = Router();
taskRoutes.use("/tasks", requireAuth, requireRole("admin", "agente"));
const status = z.enum(["pendiente", "en_curso", "completada", "cancelada"]);
const fields = z.object({ title: z.string().trim().min(3).max(160), description: z.string().trim().max(5000).default(""),
  assignedToId: z.string().uuid(), priority: z.enum(["baja", "normal", "alta"]).default("normal"),
  dueDate: z.string().date().nullable().default(null) }).strict();
const include = { assignedTo: { select: { id: true, nombre: true } }, createdBy: { select: { nombre: true } } } as const;

taskRoutes.get("/tasks", async (req, res) => {
  const query = z.object({ q: z.string().trim().max(160).optional(), status: status.optional(),
    assignedToId: z.string().uuid().optional(), page: z.coerce.number().int().min(1).max(100000).default(1) }).parse(req.query);
  const auth = req.auth!;
  const result = await runWithContext(auth, async tx => {
    const where = { tenantId: auth.tenantId!, status: query.status,
      assignedToId: auth.rol === "agente" ? auth.userId : query.assignedToId,
      ...(query.q ? { title: { contains: query.q, mode: "insensitive" as const } } : {}) };
    const [data, total] = await Promise.all([
      tx.teamTask.findMany({ where, include, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (query.page - 1) * 24, take: 24 }),
      tx.teamTask.count({ where })
    ]);
    return { data, meta: { total, page: query.page, limit: 24 } };
  });
  res.json(result);
});

taskRoutes.post("/tasks", requireRole("admin"), async (req, res) => {
  const body = fields.parse(req.body);
  const auth = req.auth!;
  const task = await runWithContext(auth, async tx => {
    const user = await tx.user.findFirst({ where: { id: body.assignedToId, tenantId: auth.tenantId!, estado: "activo", deletedAt: null, rol: { in: ["admin", "agente"] } } });
    if (!user) throw new ApiError("VALIDATION_ERROR", "Elegí un integrante activo de tu inmobiliaria.");
    return tx.teamTask.create({ data: { ...body, dueDate: body.dueDate ? new Date(body.dueDate) : null,
      tenantId: auth.tenantId!, createdById: auth.userId }, include });
  });
  res.status(201).json({ task });
});

taskRoutes.patch("/tasks/:id", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const auth = req.auth!;
  const body = (auth.rol === "admin" ? fields.partial().extend({ status: status.optional() }).strict() : z.object({ status }).strict()).parse(req.body);
  const task = await runWithContext(auth, async tx => {
    const found = await tx.teamTask.findFirst({ where: { id, tenantId: auth.tenantId!, ...(auth.rol === "agente" ? { assignedToId: auth.userId } : {}) } });
    if (!found) throw new ApiError("NOT_FOUND", "La tarea no existe.");
    if ("assignedToId" in body && body.assignedToId) {
      const user = await tx.user.findFirst({ where: { id: body.assignedToId, tenantId: auth.tenantId!, estado: "activo", deletedAt: null, rol: { in: ["admin", "agente"] } } });
      if (!user) throw new ApiError("VALIDATION_ERROR", "Elegí un integrante activo de tu inmobiliaria.");
    }
    return tx.teamTask.update({ where: { id }, data: { ...body,
      ...("dueDate" in body ? { dueDate: body.dueDate ? new Date(body.dueDate) : null } : {}) }, include });
  });
  res.json({ task });
});
