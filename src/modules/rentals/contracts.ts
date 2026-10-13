import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { config } from "../../config.js";
import { ApiError } from "../../lib/errors.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import type { AccessClaims } from "../../lib/tokens.js";

export const rentalContractRoutes = Router();
rentalContractRoutes.use("/rental-contracts", requireAuth, requireRole("admin"));

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usá una fecha válida.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, "Usá una fecha válida.");
const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Ingresá un importe con hasta dos decimales.")
  .refine((value) => /[1-9]/.test(value), "El importe debe ser mayor que cero.");

const contractFields = z.object({
  property_id: z.string().uuid(),
  owner_person_id: z.string().uuid(),
  tenant_person_id: z.string().uuid(),
  start_date: dateField,
  end_date: dateField,
  monthly_rent: money,
  currency: z.enum(["ARS", "USD"]),
  due_day: z.number().int().min(1).max(28)
}).strict();

export const createContractSchema = contractFields.refine((data) => data.end_date > data.start_date, {
  message: "La fecha de fin debe ser posterior al inicio.", path: ["end_date"]
}).refine((data) => data.owner_person_id !== data.tenant_person_id, {
  message: "Propietario e inquilino deben ser personas distintas.", path: ["tenant_person_id"]
});
const editContractSchema = contractFields.partial().refine((data) => Object.keys(data).length > 0, "Nada para actualizar.");
const noteSchema = z.object({ note: z.string().trim().min(5).max(1000) }).strict();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24)
});
const details = {
  property: { select: { id: true, titulo: true, slug: true } },
  owner: { select: { id: true, nombre: true } },
  tenantPerson: { select: { id: true, nombre: true } }
} as const;

function context(auth: AccessClaims) {
  if (!auth.tenantId) throw new ApiError("FORBIDDEN", "Se requiere una inmobiliaria.");
  return { tenantId: auth.tenantId, userId: auth.userId, rol: auth.rol };
}

async function validateParties(tx: Tx, body: z.infer<typeof contractFields>) {
  const [property, owner, tenantPerson] = await Promise.all([
    tx.property.findUnique({ where: { id: body.property_id }, select: { id: true, operacion: true } }),
    tx.rentalPerson.findUnique({ where: { id: body.owner_person_id }, select: { id: true, roles: true } }),
    tx.rentalPerson.findUnique({ where: { id: body.tenant_person_id }, select: { id: true, roles: true } })
  ]);
  if (!property || !owner || !tenantPerson) throw new ApiError("NOT_FOUND", "La propiedad o persona no existe.");
  if (property.operacion !== "alquiler" && property.operacion !== "ambos") {
    throw new ApiError("VALIDATION_ERROR", "La propiedad no admite alquiler.");
  }
  if (!owner.roles.includes("propietario") || !tenantPerson.roles.includes("inquilino")) {
    throw new ApiError("VALIDATION_ERROR", "Asigná una persona propietaria y otra inquilina.");
  }
  return { property, owner, tenantPerson };
}

function dateOnly(date: Date) { return date.toISOString().slice(0, 10); }
function todayLocal() {
  return new Date(Date.now() + config.TZ_OFFSET_HORAS * 3_600_000).toISOString().slice(0, 10);
}
function snapshot(contract: {
  propertyId: string; ownerPersonId: string; tenantPersonId: string;
  startDate: Date; endDate: Date; monthlyRent: Prisma.Decimal;
  currency: "ARS" | "USD"; dueDay: number;
}) {
  return {
    property_id: contract.propertyId,
    owner_person_id: contract.ownerPersonId,
    tenant_person_id: contract.tenantPersonId,
    start_date: dateOnly(contract.startDate), end_date: dateOnly(contract.endDate),
    monthly_rent: contract.monthlyRent.toFixed(2), currency: contract.currency,
    due_day: contract.dueDay
  };
}

rentalContractRoutes.get("/rental-contracts", async (req, res) => {
  const { page, limit } = listQuery.parse(req.query);
  const result = await runWithContext(context(req.auth!), async (tx) => {
    const [data, total] = await Promise.all([
      tx.rentalContract.findMany({ include: details, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit, take: limit }),
      tx.rentalContract.count()
    ]);
    return { data, meta: { page, limit, total } };
  });
  res.json(result);
});

rentalContractRoutes.post("/rental-contracts", async (req, res) => {
  const body = createContractSchema.parse(req.body);
  const auth = req.auth!;
  const contract = await runWithContext(context(auth), async (tx) => {
    const { property, owner, tenantPerson } = await validateParties(tx, body);
    return tx.rentalContract.create({ data: {
      tenantId: auth.tenantId!, createdById: auth.userId,
      propertyId: property.id, ownerPersonId: owner.id, tenantPersonId: tenantPerson.id,
      startDate: new Date(`${body.start_date}T00:00:00Z`),
      endDate: new Date(`${body.end_date}T00:00:00Z`),
      monthlyRent: body.monthly_rent, currency: body.currency, dueDay: body.due_day
    }, include: details });
  });
  res.status(201).json({ contract });
});

rentalContractRoutes.get("/rental-contracts/:id", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const contract = await runWithContext(context(req.auth!), (tx) => tx.rentalContract.findUnique({
    where: { id }, include: { ...details, events: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30,
      select: { id: true, action: true, details: true, actorId: true, createdAt: true } } }
  }));
  if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
  res.json({ contract });
});

rentalContractRoutes.patch("/rental-contracts/:id", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const changes = editContractSchema.parse(req.body);
  const auth = req.auth!;
  const contract = await runWithContext(context(auth), async (tx) => {
    const current = await tx.rentalContract.findUnique({ where: { id } });
    if (!current) throw new ApiError("NOT_FOUND", "El contrato no existe.");
    if (current.status !== "borrador") throw new ApiError("CONFLICT", "Sólo se puede editar un borrador.");
    const before = snapshot(current);
    const merged = createContractSchema.parse({ ...before, ...changes });
    await validateParties(tx, merged);
    const { count } = await tx.rentalContract.updateMany({ where: { id, status: "borrador" }, data: {
      propertyId: merged.property_id, ownerPersonId: merged.owner_person_id,
      tenantPersonId: merged.tenant_person_id,
      startDate: new Date(`${merged.start_date}T00:00:00Z`),
      endDate: new Date(`${merged.end_date}T00:00:00Z`),
      monthlyRent: merged.monthly_rent, currency: merged.currency, dueDay: merged.due_day
    } });
    if (!count) throw new ApiError("CONFLICT", "El borrador cambió mientras lo editabas.");
    const updated = await tx.rentalContract.findUniqueOrThrow({ where: { id }, include: details });
    await tx.rentalContractEvent.create({ data: {
      tenantId: auth.tenantId!, contractId: id, actorId: auth.userId,
      action: "edited", details: { before, after: snapshot(updated) }
    } });
    return updated;
  });
  res.json({ contract });
});

rentalContractRoutes.post("/rental-contracts/:id/activate", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { note } = noteSchema.parse(req.body);
  const auth = req.auth!;
  let contract;
  try {
    contract = await runWithContext(context(auth), async (tx) => {
      const current = await tx.rentalContract.findUnique({ where: { id } });
      if (!current) throw new ApiError("NOT_FOUND", "El contrato no existe.");
      if (current.status !== "borrador") throw new ApiError("CONFLICT", "El contrato ya no es un borrador.");
      const currentDate = todayLocal();
      if (dateOnly(current.startDate) > currentDate || dateOnly(current.endDate) < currentDate) {
        throw new ApiError("VALIDATION_ERROR", "La fecha actual debe estar dentro de la vigencia del contrato.");
      }
      await validateParties(tx, snapshot(current));
      const { count } = await tx.rentalContract.updateMany({ where: { id, status: "borrador" }, data: { status: "vigente" } });
      if (!count) throw new ApiError("CONFLICT", "El contrato cambió mientras lo activabas.");
      await tx.rentalContractEvent.create({ data: {
        tenantId: auth.tenantId!, contractId: id, actorId: auth.userId,
        action: "activated", details: { note }
      } });
      return tx.rentalContract.findUniqueOrThrow({ where: { id }, include: details });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ApiError("CONFLICT", "La propiedad ya tiene un contrato vigente.");
    }
    throw error;
  }
  res.json({ contract });
});

rentalContractRoutes.post("/rental-contracts/:id/finish", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { note } = noteSchema.parse(req.body);
  const auth = req.auth!;
  const contract = await runWithContext(context(auth), async (tx) => {
    const current = await tx.rentalContract.findUnique({ where: { id } });
    if (!current) throw new ApiError("NOT_FOUND", "El contrato no existe.");
    if (current.status !== "vigente") throw new ApiError("CONFLICT", "Sólo se puede finalizar un contrato vigente.");
    const { count } = await tx.rentalContract.updateMany({ where: { id, status: "vigente" },
      data: { status: "finalizado", closedAt: new Date() } });
    if (!count) throw new ApiError("CONFLICT", "El contrato cambió mientras lo finalizabas.");
    await tx.rentalContractEvent.create({ data: {
      tenantId: auth.tenantId!, contractId: id, actorId: auth.userId,
      action: "finished", details: { note }
    } });
    return tx.rentalContract.findUniqueOrThrow({ where: { id }, include: details });
  });
  res.json({ contract });
});
