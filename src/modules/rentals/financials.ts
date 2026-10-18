import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import type { AccessClaims } from "../../lib/tokens.js";

export const rentalFinancialRoutes = Router();
rentalFinancialRoutes.use("/rental-contracts", requireAuth, requireRole("admin"));
rentalFinancialRoutes.use("/rental-charges", requireAuth, requireRole("admin"));
rentalFinancialRoutes.use("/rental-settlements", requireAuth, requireRole("admin"));

const uuid = z.string().uuid();
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, "Fecha inválida.");
const nonnegativeMoney = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/);
const positiveMoney = nonnegativeMoney.refine((value) => new Prisma.Decimal(value).greaterThan(0));
const adjustmentSchema = z.object({
  effective_period: period,
  amount: positiveMoney,
  reason: z.string().trim().min(5).max(500)
}).strict();
const settlementSchema = z.object({
  commission: nonnegativeMoney,
  expenses: nonnegativeMoney,
  note: z.string().trim().max(1000).optional()
}).strict();
const paidSchema = z.object({
  paid_at: date,
  payment_method: z.string().trim().min(1).max(80),
  payment_reference: z.string().trim().max(160).optional()
}).strict();
const cancelSchema = z.object({ reason: z.string().trim().min(5).max(1000) }).strict();
const listSchema = z.object({ page: z.coerce.number().int().min(1).default(1) });

function context(auth: AccessClaims) {
  if (!auth.tenantId) throw new ApiError("FORBIDDEN", "Se requiere una inmobiliaria.");
  return { tenantId: auth.tenantId, userId: auth.userId, rol: auth.rol };
}
async function contractExists(tx: Tx, id: string) {
  const contract = await tx.rentalContract.findUnique({ where: { id }, select: { id: true } });
  if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
}
async function lockCharge(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))::text`;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM rental_charges WHERE id = ${id}::uuid`;
  if (!rows.length) throw new ApiError("NOT_FOUND", "El cargo no existe.");
}

rentalFinancialRoutes.get("/rental-contracts/:id/adjustments", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const data = await runWithContext(context(req.auth!), async (tx) => {
    await contractExists(tx, id);
    return tx.rentalAdjustment.findMany({ where: { contractId: id }, orderBy: { effectivePeriod: "desc" } });
  });
  res.json({ data });
});

rentalFinancialRoutes.post("/rental-contracts/:id/adjustments", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = adjustmentSchema.parse(req.body);
  const auth = req.auth!;
  let adjustment;
  try {
    adjustment = await runWithContext(context(auth), async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM rental_contracts WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked.length) throw new ApiError("NOT_FOUND", "El contrato no existe.");
      const contract = await tx.rentalContract.findUniqueOrThrow({ where: { id } });
      if (contract.status !== "vigente") throw new ApiError("CONFLICT", "Sólo se ajusta un contrato vigente.");
      const effectivePeriod = new Date(`${body.effective_period}-01T00:00:00Z`);
      const lastDay = new Date(Date.UTC(effectivePeriod.getUTCFullYear(), effectivePeriod.getUTCMonth() + 1, 0));
      if (effectivePeriod > contract.endDate || lastDay < contract.startDate) {
        throw new ApiError("VALIDATION_ERROR", "El período queda fuera del contrato.");
      }
      const [lastCharge, lastAdjustment] = await Promise.all([
        tx.rentalCharge.findFirst({ where: { contractId: id, concept: "alquiler" }, orderBy: { period: "desc" }, select: { period: true } }),
        tx.rentalAdjustment.findFirst({ where: { contractId: id }, orderBy: { effectivePeriod: "desc" }, select: { effectivePeriod: true } })
      ]);
      if ((lastCharge && effectivePeriod <= lastCharge.period)
        || (lastAdjustment && effectivePeriod <= lastAdjustment.effectivePeriod)) {
        throw new ApiError("CONFLICT", "El ajuste debe comenzar después del último cargo y ajuste registrados.");
      }
      return tx.rentalAdjustment.create({ data: {
        tenantId: auth.tenantId!, contractId: id, createdById: auth.userId,
        effectivePeriod, amount: body.amount, reason: body.reason
      } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ApiError("CONFLICT", "Ya existe un ajuste para ese período.");
    }
    throw error;
  }
  res.status(201).json({ adjustment });
});

rentalFinancialRoutes.get("/rental-contracts/:id/settlements", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { page } = listSchema.parse(req.query);
  const result = await runWithContext(context(req.auth!), async (tx) => {
    await contractExists(tx, id);
    const [data, total] = await Promise.all([
      tx.rentalSettlement.findMany({ where: { contractId: id }, orderBy: { createdAt: "desc" },
        skip: (page - 1) * 24, take: 24, include: { charge: { select: { period: true } } } }),
      tx.rentalSettlement.count({ where: { contractId: id } })
    ]);
    return { data, meta: { page, total, limit: 24 } };
  });
  res.json(result);
});

rentalFinancialRoutes.post("/rental-charges/:id/settlements", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = settlementSchema.parse(req.body);
  const auth = req.auth!;
  let settlement;
  try {
    settlement = await runWithContext(context(auth), async (tx) => {
      await lockCharge(tx, id);
      const charge = await tx.rentalCharge.findUniqueOrThrow({ where: { id },
        include: { payments: { where: { voidedAt: null }, select: { amount: true } } } });
      const paid = charge.payments.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
      if (!paid.equals(charge.amount)) throw new ApiError("CONFLICT", "El cargo debe estar cobrado por completo.");
      const active = await tx.rentalSettlement.findFirst({ where: { chargeId: id, status: { not: "cancelada" } } });
      if (active) throw new ApiError("CONFLICT", "El cargo ya tiene una liquidación activa.");
      const commission = new Prisma.Decimal(body.commission);
      const expenses = new Prisma.Decimal(body.expenses);
      const net = paid.minus(commission).minus(expenses);
      if (net.lessThan(0)) throw new ApiError("VALIDATION_ERROR", "Los descuentos superan lo cobrado.");
      return tx.rentalSettlement.create({ data: {
        tenantId: auth.tenantId!, contractId: charge.contractId, chargeId: id,
        createdById: auth.userId, gross: paid, commission, expenses, net,
        currency: charge.currency, note: body.note || null
      } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ApiError("CONFLICT", "El cargo ya tiene una liquidación activa.");
    }
    throw error;
  }
  res.status(201).json({ settlement });
});

rentalFinancialRoutes.post("/rental-settlements/:id/paid", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = paidSchema.parse(req.body);
  const auth = req.auth!;
  const settlement = await runWithContext(context(auth), async (tx) => {
    const current = await tx.rentalSettlement.findUnique({ where: { id } });
    if (!current) throw new ApiError("NOT_FOUND", "La liquidación no existe.");
    await lockCharge(tx, current.chargeId);
    const { count } = await tx.rentalSettlement.updateMany({ where: { id, status: "preparada" }, data: {
      status: "pagada", paidAt: new Date(`${body.paid_at}T00:00:00Z`),
      paymentMethod: body.payment_method, paymentReference: body.payment_reference || null,
      paidById: auth.userId
    } });
    if (!count) throw new ApiError("CONFLICT", "La liquidación ya no está preparada.");
    return tx.rentalSettlement.findUniqueOrThrow({ where: { id } });
  });
  res.json({ settlement });
});

rentalFinancialRoutes.post("/rental-settlements/:id/cancel", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = cancelSchema.parse(req.body);
  const auth = req.auth!;
  const settlement = await runWithContext(context(auth), async (tx) => {
    const current = await tx.rentalSettlement.findUnique({ where: { id } });
    if (!current) throw new ApiError("NOT_FOUND", "La liquidación no existe.");
    await lockCharge(tx, current.chargeId);
    const { count } = await tx.rentalSettlement.updateMany({ where: { id, status: "preparada" }, data: {
      status: "cancelada", cancelledAt: new Date(), cancelReason: body.reason, cancelledById: auth.userId
    } });
    if (!count) throw new ApiError("CONFLICT", "Sólo se puede cancelar una liquidación preparada.");
    return tx.rentalSettlement.findUniqueOrThrow({ where: { id } });
  });
  res.json({ settlement });
});
