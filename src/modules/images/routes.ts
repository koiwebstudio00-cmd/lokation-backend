import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import * as images from "./service.js";

export const imageRoutes = Router();

imageRoutes.use(["/properties", "/images"], requireAuth, requireRole("admin", "agente"));

const idParam = () => z.string().uuid();

imageRoutes.post("/properties/:id/images/presign", async (req, res) => {
  const propertyId = idParam().parse(req.params.id);
  const { count } = z.object({ count: z.number().int().min(1).max(20) }).parse(req.body);
  res.json({ uploads: await images.presign(req.auth!, propertyId, count) });
});

imageRoutes.post("/properties/:id/images/confirm", async (req, res) => {
  const propertyId = idParam().parse(req.params.id);
  const { keys } = z
    .object({ keys: z.array(z.string().min(1)).min(1).max(20) })
    .parse(req.body);
  res.status(201).json({ images: await images.confirm(req.auth!, propertyId, keys) });
});

imageRoutes.patch("/properties/:id/images/order", async (req, res) => {
  const propertyId = idParam().parse(req.params.id);
  const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1) }).parse(req.body);
  res.json({ images: await images.reorder(req.auth!, propertyId, ids) });
});

imageRoutes.patch("/images/:id/portada", async (req, res) => {
  res.json({ image: await images.setPortada(req.auth!, idParam().parse(req.params.id)) });
});

imageRoutes.delete("/images/:id", async (req, res) => {
  await images.removeImage(req.auth!, idParam().parse(req.params.id));
  res.json({ ok: true });
});
