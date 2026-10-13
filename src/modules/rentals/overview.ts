import { Router } from "express";
import { config } from "../../config.js";
import { ApiError } from "../../lib/errors.js";
import { runWithContext } from "../../lib/prisma.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";

export const rentalOverviewRoutes = Router();
rentalOverviewRoutes.use("/rental-overview", requireAuth, requireRole("admin"));

rentalOverviewRoutes.get("/rental-overview", async (req, res) => {
  const auth = req.auth!;
  if (!auth.tenantId) throw new ApiError("FORBIDDEN", "Se requiere una inmobiliaria.");
  const today = new Date(Date.now() + config.TZ_OFFSET_HORAS * 3_600_000).toISOString().slice(0, 10);
  const in30Days = new Date(`${today}T00:00:00Z`);
  in30Days.setUTCDate(in30Days.getUTCDate() + 30);
  const result = await runWithContext({ tenantId: auth.tenantId, userId: auth.userId, rol: auth.rol }, async (tx) => {
    const [contracts, expiring, maintenance, balances] = await Promise.all([
      tx.rentalContract.groupBy({ by: ["status"], _count: { _all: true } }),
      tx.rentalContract.findMany({ where: { status: "vigente", endDate: { gte: new Date(`${today}T00:00:00Z`),
        lte: in30Days } }, select: { id: true, endDate: true, property: { select: { titulo: true } } },
      orderBy: { endDate: "asc" }, take: 10 }),
      tx.maintenanceRequest.count({ where: { status: { in: ["abierta", "en_gestion"] } } }),
      tx.$queryRaw<{ currency: string; balance: string; overdue: string }[]>`
        SELECT c.currency::text AS currency,
          COALESCE(SUM(GREATEST(c.amount - COALESCE(p.paid, 0), 0)), 0)::text AS balance,
          COALESCE(SUM(CASE WHEN c.due_date < ${today}::date
            THEN GREATEST(c.amount - COALESCE(p.paid, 0), 0) ELSE 0 END), 0)::text AS overdue
        FROM rental_charges c
        LEFT JOIN (
          SELECT charge_id, SUM(amount) AS paid FROM rental_payments
          WHERE voided_at IS NULL GROUP BY charge_id
        ) p ON p.charge_id = c.id
        GROUP BY c.currency
      `
    ]);
    return {
      contracts: Object.fromEntries(contracts.map((item) => [item.status, item._count._all])),
      expiring, open_maintenance: maintenance,
      balances: balances.map((item) => ({ currency: item.currency, balance: item.balance, overdue: item.overdue }))
    };
  });
  res.json(result);
});
