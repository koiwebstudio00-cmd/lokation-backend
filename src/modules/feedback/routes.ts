import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import * as feedback from "./service.js";

// Sugerencias y reportes de error de los usuarios del panel. Todo bajo sesión;
// RLS acota qué ve cada rol (ver migración 0014). `tipo` viaja como campo, no
// como ruta, para no duplicar handlers.
export const feedbackRoutes = Router();

feedbackRoutes.use("/feedback", requireAuth);

const idParam = () => z.string().uuid();
const tipo = z.enum(["sugerencia", "error"]);
const estado = z.enum(["nuevo", "en_revision", "planificada", "resuelta", "descartada"]);

const filtersSchema = z.object({
  tipo: tipo.optional(),
  estado: estado.optional(),
  q: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24)
});

feedbackRoutes.get("/feedback", async (req, res) => {
  const f = filtersSchema.parse(req.query);
  res.json(
    await feedback.listFeedback(req.auth!, {
      tipo: f.tipo,
      estado: f.estado,
      q: f.q,
      page: f.page,
      limit: f.limit
    })
  );
});

const createSchema = z.object({
  tipo,
  titulo: z.string().trim().min(1).max(200),
  descripcion: z.string().trim().min(1).max(5000),
  url_contexto: z.string().trim().max(500).optional(),
  user_agent: z.string().trim().max(500).optional()
});

feedbackRoutes.post("/feedback", async (req, res) => {
  const b = createSchema.parse(req.body);
  res.status(201).json({
    item: await feedback.createFeedback(req.auth!, {
      tipo: b.tipo,
      titulo: b.titulo,
      descripcion: b.descripcion,
      urlContexto: b.url_contexto,
      userAgent: b.user_agent
    })
  });
});

// Borrar un adjunto. Va ANTES de "/feedback/:id" (aunque no colisiona: tiene un
// segmento más), por prolijidad de lectura.
feedbackRoutes.delete("/feedback/adjuntos/:id", async (req, res) => {
  await feedback.removeAdjunto(req.auth!, idParam().parse(req.params.id));
  res.json({ ok: true });
});

feedbackRoutes.get("/feedback/:id", async (req, res) => {
  res.json({ item: await feedback.getFeedback(req.auth!, idParam().parse(req.params.id)) });
});

// Cambiar estado / borrar: triaje. RLS ya lo exige; requireRole es fail-fast.
feedbackRoutes.patch("/feedback/:id", requireRole("admin", "super_admin"), async (req, res) => {
  const body = z.object({ estado }).parse(req.body);
  res.json({
    item: await feedback.updateFeedbackEstado(req.auth!, idParam().parse(req.params.id), body.estado)
  });
});

feedbackRoutes.delete("/feedback/:id", requireRole("admin", "super_admin"), async (req, res) => {
  await feedback.deleteFeedback(req.auth!, idParam().parse(req.params.id));
  res.status(204).end();
});

feedbackRoutes.post("/feedback/:id/comentarios", async (req, res) => {
  const { cuerpo } = z.object({ cuerpo: z.string().trim().min(1).max(5000) }).parse(req.body);
  res.status(201).json({
    comentario: await feedback.addComentario(req.auth!, idParam().parse(req.params.id), cuerpo)
  });
});

// ── Adjuntos: mismo flujo de 3 pasos que las fotos de propiedad ───────────────
feedbackRoutes.post("/feedback/:id/adjuntos/presign", async (req, res) => {
  const { count } = z.object({ count: z.number().int().min(1).max(6) }).parse(req.body);
  res.json({ uploads: await feedback.presignAdjuntos(req.auth!, idParam().parse(req.params.id), count) });
});

feedbackRoutes.post("/feedback/:id/adjuntos/confirm", async (req, res) => {
  const { keys } = z.object({ keys: z.array(z.string().min(1)).min(1).max(6) }).parse(req.body);
  res.status(201).json({
    adjuntos: await feedback.confirmAdjuntos(req.auth!, idParam().parse(req.params.id), keys)
  });
});
