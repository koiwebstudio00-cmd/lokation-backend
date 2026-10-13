import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { runWithContext } from "../../lib/prisma.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import type { AccessClaims } from "../../lib/tokens.js";

export const rentalPeopleRoutes = Router();
rentalPeopleRoutes.use("/rental-people", requireAuth, requireRole("admin"));

const personFields = z.object({
  nombre: z.string().trim().min(1).max(200),
  email: z.union([z.string().trim().email().max(320), z.literal("")]).optional(),
  telefono: z.string().trim().max(50).optional(),
  roles: z.array(z.enum(["propietario", "inquilino", "garante", "contacto"]))
    .min(1).max(4).refine((items) => new Set(items).size === items.length, "No repitas roles.")
}).strict();
const updateFields = personFields.partial().refine((value) => Object.keys(value).length > 0, "Nada para actualizar.");
const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24)
});
const idParam = z.string().uuid();

function context(auth: AccessClaims) {
  if (!auth.tenantId) throw new ApiError("FORBIDDEN", "Se requiere una inmobiliaria.");
  return { tenantId: auth.tenantId, userId: auth.userId, rol: auth.rol };
}

rentalPeopleRoutes.get("/rental-people", async (req, res) => {
  const query = listQuery.parse(req.query);
  const result = await runWithContext(context(req.auth!), async (tx) => {
    const where = query.q ? { OR: [
      { nombre: { contains: query.q, mode: "insensitive" as const } },
      { email: { contains: query.q, mode: "insensitive" as const } }
    ] } : {};
    const [data, total] = await Promise.all([
      tx.rentalPerson.findMany({ where, orderBy: [{ nombre: "asc" }, { id: "asc" }],
        skip: (query.page - 1) * query.limit, take: query.limit }),
      tx.rentalPerson.count({ where })
    ]);
    return { data, meta: { page: query.page, limit: query.limit, total } };
  });
  res.json(result);
});

rentalPeopleRoutes.post("/rental-people", async (req, res) => {
  const body = personFields.parse(req.body);
  const auth = req.auth!;
  const person = await runWithContext(context(auth), (tx) => tx.rentalPerson.create({ data: {
    tenantId: auth.tenantId!, createdById: auth.userId,
    nombre: body.nombre, email: body.email || null, telefono: body.telefono || null,
    roles: body.roles
  } }));
  res.status(201).json({ person });
});

rentalPeopleRoutes.get("/rental-people/:id", async (req, res) => {
  const id = idParam.parse(req.params.id);
  const person = await runWithContext(context(req.auth!), (tx) => tx.rentalPerson.findUnique({ where: { id } }));
  if (!person) throw new ApiError("NOT_FOUND", "La persona no existe.");
  res.json({ person });
});

rentalPeopleRoutes.patch("/rental-people/:id", async (req, res) => {
  const id = idParam.parse(req.params.id);
  const body = updateFields.parse(req.body);
  const person = await runWithContext(context(req.auth!), async (tx) => {
    const { count } = await tx.rentalPerson.updateMany({ where: { id }, data: {
      ...body,
      ...(body.email !== undefined ? { email: body.email || null } : {}),
      ...(body.telefono !== undefined ? { telefono: body.telefono || null } : {})
    } });
    if (!count) throw new ApiError("NOT_FOUND", "La persona no existe.");
    return tx.rentalPerson.findUniqueOrThrow({ where: { id } });
  });
  res.json({ person });
});
