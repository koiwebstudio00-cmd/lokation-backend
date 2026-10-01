import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../../config.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import * as crm from "./service.js";

export const crmRoutes = Router();

const publicLimiter: RequestHandler =
  config.NODE_ENV === "test"
    ? (_req, _res, next) => next()
    : rateLimit({
        windowMs: 60_000,
        limit: 10,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) =>
          res.status(429).json({
            error: { code: "RATE_LIMITED", message: "Demasiadas consultas. Probá en un minuto." }
          })
      });

const idParam = () => z.string().uuid();

// ── Alta pública (formulario web del sitio del cliente) ──────────────────────
const publicLeadSchema = z.object({
  property_id: z.string().uuid().optional(),
  nombre: z.string().trim().min(1, "El nombre es obligatorio.").max(200),
  email: z.string().email().optional(),
  telefono: z.string().trim().max(50).optional(),
  mensaje: z.string().trim().min(1, "El mensaje es obligatorio.").max(5000),
  // Honeypot: campo oculto que los humanos no completan.
  website: z.string().max(0, "Solicitud inválida.").optional()
});

crmRoutes.post("/public/:tenant_slug/leads", publicLimiter, async (req, res) => {
  const slug = z.string().min(1).parse(req.params.tenant_slug);
  const body = publicLeadSchema.parse(req.body);
  const lead = await crm.createPublicLead(slug, {
    propertyId: body.property_id,
    nombre: body.nombre,
    email: body.email,
    telefono: body.telefono,
    mensaje: body.mensaje
  });
  res.status(201).json({ ok: true, lead_id: lead.id });
});

// ── Gestión interna ───────────────────────────────────────────────────────────
crmRoutes.use("/leads", requireAuth, requireRole("admin", "agente"));

const filtersSchema = z.object({
  estado: z.enum(["nueva", "en_contacto", "ganada", "perdida"]).optional(),
  canal: z.enum(["web", "whatsapp", "instagram", "messenger", "manual"]).optional(),
  clasificacion: z.enum(["potencial", "fantasma"]).optional(),
  // Solo los que tienen una derivación de Agente IA sin tomar.
  atencion: z.enum(["true", "false"]).optional(),
  assigned_to: z.string().uuid().optional(),
  property_id: z.string().uuid().optional(),
  q: z.string().trim().min(1).optional(),
  sin_tomar: z.enum(["true", "false"]).optional(),
  // Opt-in: el panel de /consultas lo manda en true para esconder las
  // conversaciones del agente web. El probador NO lo manda (quiere los prueba-).
  excluir_agente_web: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24)
});

crmRoutes.get("/leads", async (req, res) => {
  const f = filtersSchema.parse(req.query);
  res.json(
    await crm.listLeads(req.auth!, {
      estado: f.estado,
      canal: f.canal,
      clasificacion: f.clasificacion,
      ...(f.atencion !== undefined ? { atencion: f.atencion === "true" } : {}),
      assignedTo: f.assigned_to,
      propertyId: f.property_id,
      q: f.q,
      sinTomar: f.sin_tomar === undefined ? undefined : f.sin_tomar === "true",
      excluirAgenteWeb: f.excluir_agente_web === "true",
      page: f.page,
      limit: f.limit
    })
  );
});

crmRoutes.get("/leads/stats", requireRole("admin"), async (req, res) => {
  res.json(await crm.leadStats(req.auth!));
});

crmRoutes.post("/leads", async (req, res) => {
  const body = z
    .object({
      nombre: z.string().trim().min(1).max(200),
      email: z.string().email().optional(),
      telefono: z.string().trim().max(50).optional(),
      mensaje: z.string().trim().min(1).max(5000),
      property_id: z.string().uuid().optional()
    })
    .parse(req.body);
  const lead = await crm.createManualLead(req.auth!, {
    nombre: body.nombre,
    email: body.email,
    telefono: body.telefono,
    mensaje: body.mensaje,
    propertyId: body.property_id
  });
  res.status(201).json({ lead });
});

crmRoutes.post("/leads/:id/take", async (req, res) => {
  const lead = await crm.takeLead(req.auth!, idParam().parse(req.params.id));
  res.json({ lead });
});

crmRoutes.get("/leads/:id", async (req, res) => {
  res.json({ lead: await crm.getLead(req.auth!, idParam().parse(req.params.id)) });
});

crmRoutes.patch("/leads/:id", async (req, res) => {
  const id = idParam().parse(req.params.id);
  const body = z
    .object({
      estado: z.enum(["nueva", "en_contacto", "ganada", "perdida"]).optional(),
      clasificacion: z.enum(["potencial", "fantasma"]).nullable().optional(),
      assigned_to: z.string().uuid().nullable().optional(),
      nombre: z.string().trim().min(1).max(200).optional(),
      // "" desde el form = borrar el email. La API lo normaliza a null.
      email: z.union([z.string().trim().email(), z.literal("")]).nullable().optional()
    })
    .refine(
      (b) =>
        b.estado !== undefined ||
        b.clasificacion !== undefined ||
        b.assigned_to !== undefined ||
        b.nombre !== undefined ||
        b.email !== undefined,
      { message: "Nada para actualizar." }
    )
    .parse(req.body);
  const lead = await crm.updateLead(req.auth!, id, {
    estado: body.estado,
    ...(body.clasificacion !== undefined ? { clasificacion: body.clasificacion } : {}),
    ...(body.assigned_to !== undefined ? { assignedTo: body.assigned_to } : {}),
    ...(body.nombre !== undefined ? { nombre: body.nombre } : {}),
    ...(body.email !== undefined ? { email: body.email === "" ? null : body.email } : {})
  });
  res.json({ lead });
});

// Borrar una consulta. Solo admin (la policy RLS `leads_delete` ya lo exige; el
// requireRole es fail-fast). El cascade del esquema limpia notas, conversación,
// mensajes y handoffs.
crmRoutes.delete("/leads/:id", requireRole("admin"), async (req, res) => {
  await crm.deleteLead(req.auth!, idParam().parse(req.params.id));
  res.status(204).end();
});

crmRoutes.post("/leads/:id/notes", async (req, res) => {
  const id = idParam().parse(req.params.id);
  const { nota } = z.object({ nota: z.string().trim().min(1).max(5000) }).parse(req.body);
  res.status(201).json({ note: await crm.addNote(req.auth!, id, nota) });
});
