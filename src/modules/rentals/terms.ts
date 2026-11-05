import { Router } from "express";
import { Prisma, type RentalTerms } from "@prisma/client";
import { z } from "zod";
import { config } from "../../config.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";

export const rentalTermsRoutes = Router();
rentalTermsRoutes.use("/rental-contracts", requireAuth, requireRole("admin"));
export const termsOrder = [{ effectivePeriod: "desc" }, { createdAt: "desc" }, { id: "desc" }] as const;
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const percent = z.string().regex(/^\d{1,4}(\.\d{1,2})?$/);
export const termsSchema = z.object({
  effective_period: period,
  commission_rate: percent.refine(value => new Prisma.Decimal(value).lte(100), "La comisión debe estar entre 0 y 100%."),
  commission_basis: z.enum(["alquiler_cobrado", "alquiler_periodo"]),
  adjustment_method: z.enum(["sin_actualizacion", "manual", "ICL", "IPC", "fijo", "otro"]),
  frequency_months: z.number().int().min(1).max(36).nullable(),
  first_adjustment_period: period.nullable(), fixed_percent: percent.nullable(),
  note: z.string().trim().min(5).max(1000)
}).strict().superRefine((body, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (body.adjustment_method === "sin_actualizacion") {
    if (body.frequency_months !== null || body.first_adjustment_period !== null || body.fixed_percent !== null) issue("Sin actualización no admite frecuencia ni porcentaje de ajuste.");
  } else {
    if (!body.frequency_months || !body.first_adjustment_period) issue("Indicá frecuencia y primer período de actualización.");
    if (body.first_adjustment_period && body.first_adjustment_period < body.effective_period) issue("La primera actualización no puede ser anterior a la vigencia de las condiciones.");
    if ((body.adjustment_method === "fijo") !== (body.fixed_percent !== null)) issue("El porcentaje de actualización sólo corresponde al método fijo.");
  }
});
export const periodDate = (value: string) => new Date(`${value}-01T00:00:00Z`);
export const currentPeriod = () => periodDate(new Date(Date.now() + config.TZ_OFFSET_HORAS * 3600000).toISOString().slice(0,7));
export function termsAt(versions: RentalTerms[], date: Date) { return versions.find(item => item.effectivePeriod <= date) ?? null; }
export function commissionProposal(terms: RentalTerms | null, charge: { concept: string; amount: Prisma.Decimal }, paid: Prisma.Decimal) {
  if (!terms) return null;
  const base = charge.concept === "alquiler" ? (terms.commissionBasis === "alquiler_cobrado" ? paid : charge.amount) : new Prisma.Decimal(0);
  return { termsId: terms.id, rate: terms.commissionRate.toFixed(2), basis: terms.commissionBasis,
    base: base.toFixed(2), amount: base.mul(terms.commissionRate).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2) };
}
function monthNumber(value: Date) { return value.getUTCFullYear() * 12 + value.getUTCMonth(); }
export function nextAdjustment(terms: RentalTerms | null, latest: Date | null, end: Date) {
  if (!terms?.firstAdjustmentPeriod || !terms.frequencyMonths || terms.adjustmentMethod === "sin_actualizacion") return null;
  const anchor = monthNumber(terms.firstAdjustmentPeriod);
  const last = latest ? monthNumber(latest) : anchor - 1;
  const next = anchor + Math.max(0, Math.floor((last - anchor) / terms.frequencyMonths) + 1) * terms.frequencyMonths;
  const date = new Date(Date.UTC(Math.floor(next / 12), next % 12, 1));
  return date <= end ? date : null;
}
export async function termsOverview(tx: Tx, id: string) {
  const contract = await tx.rentalContract.findUnique({ where: { id } });
  if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
  const [versions, adjustments] = await Promise.all([
    tx.rentalTerms.findMany({ where: { contractId: id }, orderBy: [...termsOrder] }),
    tx.rentalAdjustment.findMany({ where: { contractId: id }, orderBy: { effectivePeriod: "desc" } })
  ]);
  const applicable = termsAt(versions, currentPeriod());
  const candidate = contract.status === "finalizado" ? null : nextAdjustment(applicable, adjustments[0]?.effectivePeriod ?? null, contract.endDate);
  // A scheduled future version supersedes the current rule before its next review.
  const next = candidate && termsAt(versions, candidate)?.id === applicable?.id ? candidate : null;
  const base = adjustments[0]?.amount ?? contract.monthlyRent;
  const suggestedAmount = next && applicable?.adjustmentMethod === "fijo" && applicable.fixedPercent !== null
    ? base.mul(new Prisma.Decimal(1).plus(applicable.fixedPercent.div(100))).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2) : null;
  return { versions, applicable, nextAdjustmentPeriod: next, suggestedAmount, currentPeriod: currentPeriod(),
    overdue: Boolean(next && next <= currentPeriod()), status: contract.status };
}

rentalTermsRoutes.get("/rental-contracts/:id/terms", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  res.json(await runWithContext(req.auth!, tx => termsOverview(tx, id)));
});
rentalTermsRoutes.post("/rental-contracts/:id/terms", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const body = termsSchema.parse(req.body);
  const auth = req.auth!;
  const terms = await runWithContext(auth, async tx => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM rental_contracts WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked.length) throw new ApiError("NOT_FOUND", "El contrato no existe.");
    const contract = await tx.rentalContract.findUniqueOrThrow({ where: { id } });
    if (contract.status === "finalizado") throw new ApiError("CONFLICT", "El contrato está finalizado.");
    const effective = periodDate(body.effective_period);
    const first = body.first_adjustment_period ? periodDate(body.first_adjustment_period) : null;
    if (body.effective_period < contract.startDate.toISOString().slice(0,7) || effective > contract.endDate || (first && first > contract.endDate)) throw new ApiError("VALIDATION_ERROR", "Las fechas deben estar dentro de la vigencia del contrato.");
    const settled = await tx.rentalSettlement.findFirst({ where: { contractId: id, status: { not: "cancelada" }, charge: { period: { gte: effective } } } });
    if (settled) throw new ApiError("CONFLICT", "Hay liquidaciones activas desde ese período. Elegí una vigencia posterior; sus condiciones se conservan.");
    const terms = await tx.rentalTerms.create({ data: { tenantId: auth.tenantId!, contractId: id, createdById: auth.userId,
      effectivePeriod: effective, commissionRate: body.commission_rate, commissionBasis: body.commission_basis,
      adjustmentMethod: body.adjustment_method, frequencyMonths: body.frequency_months,
      firstAdjustmentPeriod: first, fixedPercent: body.fixed_percent, note: body.note } });
    await tx.rentalContractEvent.create({ data: { tenantId: auth.tenantId!, contractId: id, actorId: auth.userId,
      action: "terms_changed", details: { termsId: terms.id, ...body } } });
    return terms;
  });
  res.status(201).json({ terms });
});
