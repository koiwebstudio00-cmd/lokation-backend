import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { runWithContext } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";

export const notificationRoutes = Router();
notificationRoutes.use("/notifications", requireAuth);
notificationRoutes.get("/notifications", async (req, res) => {
  const { page, limit } = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
  const result = await runWithContext(req.auth!, async (tx) => {
    const where = { userId: req.auth!.userId };
    const [items, total, unread] = await Promise.all([
      tx.notification.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page-1)*limit, take: limit }),
      tx.notification.count({ where }), tx.notification.count({ where: { ...where, readAt: null } })
    ]);
    return { items, total, unread, page, limit };
  });
  res.json(result);
});
notificationRoutes.patch("/notifications/read-all", async (req, res) => {
  await runWithContext(req.auth!, (tx) => tx.notification.updateMany({
    where: { userId: req.auth!.userId, readAt: null }, data: { readAt: new Date() }
  }));
  res.json({ ok: true });
});
notificationRoutes.patch("/notifications/:id/read", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await runWithContext(req.auth!, async (tx) => {
    const item = await tx.notification.findFirst({ where: { id, userId: req.auth!.userId } });
    if (!item) throw new ApiError("NOT_FOUND", "Notificación no encontrada.");
    if (!item.readAt) await tx.notification.update({ where: { id }, data: { readAt: new Date() } });
  });
  res.json({ ok: true });
});
