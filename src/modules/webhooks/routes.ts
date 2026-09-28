import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import * as webhooks from "./service.js";

export const webhookRoutes = Router();

webhookRoutes.use("/webhooks", requireAuth, requireRole("admin", "super_admin"));

const idParam = () => z.string().uuid();
const eventosSchema = z
  .array(z.enum(webhooks.EVENTOS_VALIDOS))
  .min(1, "Suscribí al menos un evento.");

webhookRoutes.get("/webhooks", async (req, res) => {
  res.json({ data: await webhooks.listEndpoints(req.auth!) });
});

webhookRoutes.post("/webhooks", async (req, res) => {
  const body = z
    .object({ url: z.string().min(1), eventos: eventosSchema })
    .parse(req.body);
  const endpoint = await webhooks.createEndpoint(req.auth!, body);
  res.status(201).json({ endpoint }); // incluye secret una única vez
});

webhookRoutes.patch("/webhooks/:id", async (req, res) => {
  const id = idParam().parse(req.params.id);
  const body = z
    .object({
      url: z.string().min(1).optional(),
      eventos: eventosSchema.optional(),
      activo: z.boolean().optional(),
      rotate_secret: z.boolean().optional()
    })
    .parse(req.body);
  const endpoint = await webhooks.updateEndpoint(req.auth!, id, {
    url: body.url,
    eventos: body.eventos,
    activo: body.activo,
    rotateSecret: body.rotate_secret
  });
  res.json({ endpoint });
});

webhookRoutes.delete("/webhooks/:id", async (req, res) => {
  await webhooks.deleteEndpoint(req.auth!, idParam().parse(req.params.id));
  res.json({ ok: true });
});

webhookRoutes.get("/webhooks/:id/deliveries", async (req, res) => {
  res.json({ data: await webhooks.listDeliveries(req.auth!, idParam().parse(req.params.id)) });
});

webhookRoutes.post("/webhooks/:id/test", async (req, res) => {
  await webhooks.sendTest(req.auth!, idParam().parse(req.params.id));
  res.json({ ok: true, message: "Ping encolado; se entrega en segundos." });
});
