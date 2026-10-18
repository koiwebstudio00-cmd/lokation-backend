import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { runWithContext } from "../../lib/prisma.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";

export const rentalInquiryRoutes = Router();
rentalInquiryRoutes.use("/rental-inquiries", requireAuth, requireRole("admin"));
const uuid = z.string().uuid();

rentalInquiryRoutes.get("/rental-inquiries", async (req, res) => {
  const query = z.object({ contract_id: uuid.optional(), status: z.enum(["abierta", "en_gestion", "resuelta"]).optional(),
    page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  const auth = req.auth!;
  const result = await runWithContext({ tenantId: auth.tenantId!, userId: auth.userId, rol: "admin" }, async (tx) => {
    const where = { ...(query.contract_id ? { contractId: query.contract_id } : {}),
      ...(query.status ? { status: query.status } : {}) };
    const [data, total] = await Promise.all([
      tx.rentalInquiry.findMany({ where, include: { contract: { select: { property: { select: { titulo: true } } } },
        account: { select: { email: true } } }, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * 24, take: 24 }),
      tx.rentalInquiry.count({ where })
    ]);
    return { data, meta: { page: query.page, total, limit: 24 } };
  });
  res.json(result);
});

rentalInquiryRoutes.post("/rental-inquiries/:id/respond", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = z.object({ status: z.enum(["en_gestion", "resuelta"]),
    response: z.string().trim().min(5).max(5000) }).strict().parse(req.body);
  const auth = req.auth!;
  const item = await runWithContext({ tenantId: auth.tenantId!, userId: auth.userId, rol: "admin" }, async (tx) => {
    const current = await tx.rentalInquiry.findUnique({ where: { id } });
    if (!current) throw new ApiError("NOT_FOUND", "La consulta no existe.");
    if (current.status === "resuelta") throw new ApiError("CONFLICT", "La consulta ya está resuelta.");
    return tx.rentalInquiry.update({ where: { id }, data: {
      status: body.status, response: body.response, answeredById: auth.userId, answeredAt: new Date()
    } });
  });
  res.json({ item });
});
