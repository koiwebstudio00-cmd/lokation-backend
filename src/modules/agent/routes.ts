import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../../config.js";
import { requireApiKey } from "../../middleware/apiKey.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { ESTADOS, MASCOTAS, AMOBLADO } from "../../lib/property-opciones.js";
import * as agent from "./service.js";
import { resumenSchema } from "./resumen.js";
import { zoneAlternatives } from "./property-search.js";

// ── Lo que consume n8n con X-Api-Key ─────────────────────────────────────────
export const agentRoutes = Router();

// Más holgado que export: el agente hace hasta 4 llamadas por mensaje entrante,
// y una ráfaga de mensajes de varios leads a la vez es normal, no un abuso.
const agentLimiter: RequestHandler =
  config.NODE_ENV === "test"
    ? (_req, _res, next) => next()
    : rateLimit({
        windowMs: 60_000,
        limit: 600,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => req.integration?.keyId ?? "sin-key",
        handler: (_req, res) =>
          res.status(429).json({
            error: { code: "RATE_LIMITED", message: "Demasiadas consultas. Probá en un minuto." }
          })
      });

const idParam = () => z.string().uuid();
const tenantOf = (req: { integration?: { tenantId: string } }) => req.integration!.tenantId;

// ── Tool buscar_propiedades (solo lectura) ───────────────────────────────────
// n8n (HTTP Request Tool) manda TODOS los query params del `$fromAI`, incluso
// los que el modelo no completó, con string vacío. Sin esto, un `precio_max=`
// rompería el enum/`min(1)`/coerción y devolvería 400 o filtraría de más. Se
// descartan los `""` acá para que el `.optional()` de cada campo haga su trabajo.
const dropEmpty = (v: unknown) =>
  v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).filter(([, val]) => val !== ""))
    : v;

const queryList = (item: z.ZodString, max: number) => z.preprocess(
  (value) => typeof value === "string" ? value.split(",").map((part) => part.trim()).filter(Boolean) : value,
  z.array(item).max(max).optional()
);

const searchSchema = z.preprocess(dropEmpty, z.object({
  q: z.string().trim().min(1).max(200).optional(),
  operacion: z.enum(["venta", "alquiler"]).optional(),
  // Preserve legacy unknown-type behavior; the service reports ignored types.
  tipo: z.string().trim().min(1).max(50).optional(),
  estado: z.enum(ESTADOS).optional().catch(undefined),
  zona: z.string().trim().min(1).optional(),
  ciudad: z.string().trim().min(1).optional(),
  zonas: queryList(z.string().trim().min(1).max(100), 10),
  moneda: z.enum(["ARS", "USD"]).optional(),
  mascotas: z.enum(MASCOTAS).optional(),
  amoblado: z.enum(AMOBLADO).optional(),
  excluir_ids: queryList(z.string().uuid(), 50),
  excluir_slugs: queryList(z.string().min(1).max(200).regex(/^[a-z0-9-]+$/), 50),
  precio_min: z.coerce.number().min(0).optional(),
  precio_max: z.coerce.number().min(0).optional(),
  ambientes: z.coerce.number().int().min(0).optional(),
  dormitorios_min: z.coerce.number().int().min(0).optional(),
  dormitorios_max: z.coerce.number().int().min(0).optional(),
  ambientes_exactos: z.coerce.number().int().min(0).optional(),
  sort: z.enum(["recent", "price-asc", "price-desc"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  // Tope bajo a propósito: al modelo hay que darle un puñado de opciones
  // buenas, no un catálogo. Más resultados = más tokens y peor respuesta.
  limit: z.coerce.number().int().min(1).max(20).default(5)
}).superRefine((value, ctx) => {
  const zones = zoneAlternatives(value.zona, value.zonas);
  if ((value.zona || value.zonas?.length) && !zones.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["zonas"], message: "Indicá al menos una zona válida." });
  if (zones.length > 10)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["zonas"], message: "Podés indicar hasta 10 zonas alternativas." });
  if (value.precio_min !== undefined && value.precio_max !== undefined && value.precio_min > value.precio_max)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["precio_max"], message: "El precio máximo debe ser mayor o igual al mínimo." });
  if (value.dormitorios_min !== undefined && value.dormitorios_max !== undefined && value.dormitorios_min > value.dormitorios_max)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dormitorios_max"], message: "El máximo de dormitorios debe ser mayor o igual al mínimo." });
}));

agentRoutes.get(
  "/agent/properties",
  requireApiKey("agent:read"),
  agentLimiter,
  async (req, res) => {
    const f = searchSchema.parse(req.query);
    res.json(
      await agent.buscarPropiedades(tenantOf(req), {
        q: f.q,
        operacion: f.operacion,
        tipo: f.tipo,
        estado: f.estado,
        zona: f.zona,
        ciudad: f.ciudad,
        zonas: f.zonas,
        moneda: f.moneda,
        mascotas: f.mascotas,
        amoblado: f.amoblado,
        excluirIds: f.excluir_ids,
        excluirSlugs: f.excluir_slugs,
        precioMin: f.precio_min,
        precioMax: f.precio_max,
        ambientes: f.ambientes,
        dormitorios: f.dormitorios_min,
        dormitoriosMax: f.dormitorios_max,
        ambientesExactos: f.ambientes_exactos,
        sort: f.sort,
        page: f.page,
        limit: f.limit
      })
    );
  }
);

agentRoutes.get("/agent/properties/identify", requireApiKey("agent:read"), agentLimiter, async (req, res) => {
  const { referencia } = z.object({ referencia: z.string().trim().min(1).max(500) }).parse(req.query);
  res.json(await agent.identificarPropiedad(tenantOf(req), referencia));
});

agentRoutes.get("/agent/properties/catalog", requireApiKey("agent:read"), agentLimiter, async (req, res) => {
  z.object({}).strict().parse(req.query);
  res.json(await agent.catalogoPropiedades(tenantOf(req)));
});

// Tool ver_propiedad: detalle por id o slug. Va después de la ruta de búsqueda
// (que es exacta, sin parámetro), así no la captura este patrón con :idOrSlug.
agentRoutes.get(
  "/agent/properties/:idOrSlug",
  requireApiKey("agent:read"),
  agentLimiter,
  async (req, res) => {
    const idOrSlug = z.string().trim().min(1).max(200).parse(req.params.idOrSlug);
    res.json(await agent.verPropiedad(tenantOf(req), idOrSlug));
  }
);

agentRoutes.get(
  "/agent/vendedores",
  requireApiKey("agent:read"),
  agentLimiter,
  async (req, res) => {
    res.json({ data: await agent.listarVendedores(tenantOf(req)) });
  }
);

agentRoutes.get(
  "/agent/conversations/:id/context",
  requireApiKey("agent:read"),
  agentLimiter,
  async (req, res) => {
    const { k } = z.object({ k: z.coerce.number().int().min(1).max(100).default(20) }).parse(
      req.query
    );
    res.json(await agent.contextoDelModelo(tenantOf(req), idParam().parse(req.params.id), k));
  }
);

// ── Escritura ────────────────────────────────────────────────────────────────
const abrirSchema = z
  .object({
    canal: z.enum(["whatsapp", "web"]),
    canal_ref: z.string().trim().min(1).max(120),
    nombre: z.string().trim().max(200).optional(),
    property_id: z.string().uuid().optional(),
    mensaje: z.string().trim().max(5000).optional(),
    channel_account_id: z.string().uuid().optional(),
    provider_conversation_id: z.string().trim().min(1).max(200).optional()
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.channel_account_id) !== Boolean(value.provider_conversation_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "channel_account_id y provider_conversation_id deben enviarse juntos."
      });
    }
    if (value.canal !== "whatsapp" && value.channel_account_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "La identidad de proveedor sólo aplica a WhatsApp."
      });
    }
  });

agentRoutes.post(
  "/agent/conversations",
  requireApiKey("agent:write"),
  agentLimiter,
  async (req, res) => {
    const b = abrirSchema.parse(req.body);
    const out = await agent.abrirConversacion(tenantOf(req), {
      canal: b.canal,
      canalRef: b.canal_ref,
      nombre: b.nombre,
      propertyId: b.property_id,
      mensaje: b.mensaje,
      channelAccountId: b.channel_account_id,
      providerConversationId: b.provider_conversation_id
    });
    // 201 solo cuando de verdad se creó: n8n distingue el alta del reingreso.
    res.status(out.creada ? 201 : 200).json(out);
  }
);

const mensajesSchema = z.object({
  mensajes: z
    .array(
      z.object({
        rol: z.enum(["lead", "agente_ia", "vendedor", "sistema"]),
        tipo: z.enum(["texto", "audio", "imagen", "documento", "plantilla"]).optional(),
        contenido: z.string().trim().min(1).max(10000),
        media_url: z.string().url().optional(),
        meta: z.record(z.unknown()).optional()
      })
    )
    .min(1)
    .max(20)
});

agentRoutes.post(
  "/agent/conversations/:id/messages",
  requireApiKey("agent:write"),
  agentLimiter,
  async (req, res) => {
    const id = idParam().parse(req.params.id);
    const { mensajes } = mensajesSchema.parse(req.body);
    res.status(201).json(
      await agent.registrarMensajes(
        tenantOf(req),
        id,
        mensajes.map((m) => ({
          rol: m.rol,
          tipo: m.tipo,
          contenido: m.contenido,
          mediaUrl: m.media_url,
          meta: m.meta
        }))
      )
    );
  }
);

agentRoutes.put(
  "/agent/conversations/:id/resumen",
  requireApiKey("agent:write"),
  agentLimiter,
  async (req, res) => {
    const id = idParam().parse(req.params.id);
    const { resumen } = z.object({ resumen: resumenSchema }).parse(req.body);
    res.json({ conversation: await agent.guardarResumen(tenantOf(req), id, resumen) });
  }
);

agentRoutes.post(
  "/agent/conversations/:id/handoff",
  requireApiKey("agent:write"),
  agentLimiter,
  async (req, res) => {
    const id = idParam().parse(req.params.id);
    const b = z
      .object({
        motivo: z.enum(["visita", "reserva", "tasacion", "pedido_humano", "fuera_de_alcance"]),
        resumen: resumenSchema.optional()
      })
      .parse(req.body);
    res.json(await agent.derivar(tenantOf(req), id, b));
  }
);

agentRoutes.patch(
  "/agent/vendedores/:id",
  requireApiKey("agent:write"),
  agentLimiter,
  async (req, res) => {
    const id = idParam().parse(req.params.id);
    const { activo } = z.object({ activo: z.boolean() }).parse(req.body);
    res.json({ vendedor: await agent.setDisponibilidad(tenantOf(req), id, activo) });
  }
);

// Cron de n8n. Es POST y no GET porque muta: reasigna y notifica.
agentRoutes.post(
  "/agent/handoffs/vencidos",
  requireApiKey("agent:write"),
  agentLimiter,
  async (req, res) => {
    res.json(await agent.procesarVencidos(tenantOf(req)));
  }
);

// ── Lo que consume el panel con sesión ───────────────────────────────────────
// Router aparte: mismo dominio, autenticación y RLS completamente distintas.
// Acá manda la sesión del vendedor, no la API key del agente.
export const conversationRoutes = Router();

conversationRoutes.use("/conversations", requireAuth, requireRole("admin", "agente"));

conversationRoutes.get("/conversations", async (req, res) => {
  const f = z
    .object({
      lead_id: z.string().uuid().optional(),
      estado: z.enum(["bot", "esperando_humano", "humano", "cerrada"]).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(24)
    })
    .parse(req.query);
  res.json(
    await agent.listarConversaciones(req.auth!, {
      leadId: f.lead_id,
      estado: f.estado,
      page: f.page,
      limit: f.limit
    })
  );
});

conversationRoutes.get("/conversations/:id/messages", async (req, res) => {
  const id = idParam().parse(req.params.id);
  // `after` es el id del último mensaje que ya tiene el panel: con eso el
  // polling trae solo lo nuevo en vez del historial entero cada 10 segundos.
  const { after } = z.object({ after: z.coerce.bigint().optional() }).parse(req.query);
  res.json(await agent.mensajesDeConversacion(req.auth!, id, after));
});

conversationRoutes.post("/conversations/:id/take", async (req, res) => {
  const id = idParam().parse(req.params.id);
  res.json({ conversation: await agent.tomarConversacion(req.auth!, id) });
});

conversationRoutes.post("/conversations/:id/release", async (req, res) => {
  const id = idParam().parse(req.params.id);
  res.json({ conversation: await agent.liberarConversacion(req.auth!, id) });
});
