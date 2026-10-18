import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import type { AccessClaims } from "../../lib/tokens.js";

export const rentalChargeRoutes = Router();
rentalChargeRoutes.use("/rental-contracts", requireAuth, requireRole("admin"));
rentalChargeRoutes.use("/rental-charges", requireAuth, requireRole("admin"));
rentalChargeRoutes.use("/rental-payments", requireAuth, requireRole("admin"));

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, "Fecha inválida.");
const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/)
  .refine((value) => new Prisma.Decimal(value).greaterThan(0), "El importe debe ser positivo.");
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const paymentSchema = z.object({
  idempotency_key: uuid,
  amount: money,
  paid_at: date,
  method: z.string().trim().min(1).max(80),
  reference: z.string().trim().max(160).optional(),
  note: z.string().trim().max(1000).optional()
}).strict();
const voidSchema = z.object({ reason: z.string().trim().min(5).max(1000) }).strict();

function context(auth: AccessClaims) {
  if (!auth.tenantId) throw new ApiError("FORBIDDEN", "Se requiere una inmobiliaria.");
  return { tenantId: auth.tenantId, userId: auth.userId, rol: auth.rol };
}
async function lockCharge(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))::text`;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM rental_charges WHERE id = ${id}::uuid`;
  if (!rows.length) throw new ApiError("NOT_FOUND", "El cargo no existe.");
}
function summary<T extends { amount: Prisma.Decimal; payments: { amount: Prisma.Decimal; voidedAt: Date | null }[] }>(charge: T) {
  const paid = charge.payments.reduce((sum, payment) => payment.voidedAt ? sum : sum.plus(payment.amount), new Prisma.Decimal(0));
  return { ...charge, paid: paid.toFixed(2), balance: charge.amount.minus(paid).toFixed(2) };
}

rentalChargeRoutes.get("/rental-contracts/:id/charges", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const page = z.coerce.number().int().min(1).parse(req.query.page ?? 1);
  const result = await runWithContext(context(req.auth!), async (tx) => {
    const contract = await tx.rentalContract.findUnique({ where: { id }, select: { id: true } });
    if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
    const [charges, total] = await Promise.all([
      tx.rentalCharge.findMany({ where: { contractId: id }, include: { payments: { orderBy: { createdAt: "desc" } } },
        orderBy: { period: "desc" }, skip: (page - 1) * 24, take: 24 }),
      tx.rentalCharge.count({ where: { contractId: id } })
    ]);
    return { data: charges.map(summary), meta: { page, limit: 24, total } };
  });
  res.json(result);
});

rentalChargeRoutes.post("/rental-contracts/:id/charges", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { period: requestedPeriod } = z.object({ period }).strict().parse(req.body);
  const auth = req.auth!;
  const result = await runWithContext(context(auth), async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM rental_contracts WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked.length) throw new ApiError("NOT_FOUND", "El contrato no existe.");
    const contract = await tx.rentalContract.findUniqueOrThrow({ where: { id } });
    if (contract.status !== "vigente") throw new ApiError("CONFLICT", "Solo se pueden generar cargos de contratos vigentes.");
    const first = new Date(`${requestedPeriod}-01T00:00:00Z`);
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    if (first > contract.endDate || last < contract.startDate) {
      throw new ApiError("VALIDATION_ERROR", "El período queda fuera de la vigencia del contrato.");
    }
    const existing = await tx.rentalCharge.findUnique({ where: {
      contractId_period_concept: { contractId: id, period: first, concept: "alquiler" }
    } });
    if (existing) return { charge: existing, created: false };
    const adjustment = await tx.rentalAdjustment.findFirst({ where: {
      contractId: id, effectivePeriod: { lte: first }
    }, orderBy: { effectivePeriod: "desc" }, select: { amount: true } });
    const due = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(contract.dueDay, last.getUTCDate())));
    const dueDate = due < contract.startDate ? contract.startDate : due;
    const charge = await tx.rentalCharge.create({ data: {
      tenantId: auth.tenantId!, contractId: id, createdById: auth.userId,
      period: first, dueDate, amount: adjustment?.amount ?? contract.monthlyRent, currency: contract.currency,
      concept: "alquiler"
    } });
    return { charge, created: true };
  });
  res.status(result.created ? 201 : 200).json(result);
});

rentalChargeRoutes.post("/rental-charges/:id/payments", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = paymentSchema.parse(req.body);
  const auth = req.auth!;
  const result = await runWithContext(context(auth), async (tx) => {
    await lockCharge(tx, id);
    const existing = await tx.rentalPayment.findUnique({ where: {
      tenantId_idempotencyKey: { tenantId: auth.tenantId!, idempotencyKey: body.idempotency_key }
    } });
    if (existing) {
      if (existing.chargeId !== id || !existing.amount.equals(body.amount)
        || existing.paidAt.toISOString().slice(0, 10) !== body.paid_at || existing.method !== body.method
        || (existing.reference ?? "") !== (body.reference ?? "")
        || (existing.note ?? "") !== (body.note ?? "")) {
        throw new ApiError("CONFLICT", "La clave de operación ya se usó con otros datos.");
      }
      return { payment: existing, created: false };
    }
    const charge = await tx.rentalCharge.findUniqueOrThrow({ where: { id },
      include: { payments: { where: { voidedAt: null }, select: { amount: true } } } });
    const paid = charge.payments.reduce((sum, payment) => sum.plus(payment.amount), new Prisma.Decimal(0));
    if (new Prisma.Decimal(body.amount).plus(paid).greaterThan(charge.amount)) {
      throw new ApiError("CONFLICT", "El cobro supera el saldo del cargo.");
    }
    const payment = await tx.rentalPayment.create({ data: {
      tenantId: auth.tenantId!, chargeId: id, createdById: auth.userId,
      idempotencyKey: body.idempotency_key, amount: body.amount,
      paidAt: new Date(`${body.paid_at}T00:00:00Z`), method: body.method,
      reference: body.reference || null, note: body.note || null
    } });
    return { payment, created: true };
  });
  res.status(result.created ? 201 : 200).json(result);
});

rentalChargeRoutes.post("/rental-payments/:id/void", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { reason } = voidSchema.parse(req.body);
  const auth = req.auth!;
  const payment = await runWithContext(context(auth), async (tx) => {
    const existing = await tx.rentalPayment.findUnique({ where: { id } });
    if (!existing) throw new ApiError("NOT_FOUND", "El cobro no existe.");
    await lockCharge(tx, existing.chargeId);
    const settlement = await tx.rentalSettlement.findFirst({ where: {
      chargeId: existing.chargeId, status: { not: "cancelada" }
    }, select: { id: true } });
    if (settlement) throw new ApiError("CONFLICT", "Cancelá la liquidación preparada antes de revertir el cobro. Una liquidación pagada no admite reversión.");
    const { count } = await tx.rentalPayment.updateMany({ where: { id, voidedAt: null },
      data: { voidedAt: new Date(), voidReason: reason, voidedById: auth.userId } });
    if (!count) throw new ApiError("CONFLICT", "El cobro ya fue revertido.");
    return tx.rentalPayment.findUniqueOrThrow({ where: { id } });
  });
  res.json({ payment });
});
