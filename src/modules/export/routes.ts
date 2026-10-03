import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../../config.js";
import { requireApiKey } from "../../middleware/apiKey.js";
import { TIPOS, ESTADOS } from "../../lib/property-opciones.js";
import * as exportSvc from "./service.js";

// La gestión de API keys vive en modules/integrations desde 0011: acá quedó
// solo lo que el nombre del módulo dice, servir datos públicos del tenant.
export const exportRoutes = Router();

// ── Consumo con X-Api-Key (rate limit 120/min por key, cache CDN) ────────────
const exportLimiter: RequestHandler =
  config.NODE_ENV === "test"
    ? (_req, _res, next) => next()
    : rateLimit({
        windowMs: 60_000,
        limit: 120,
        standardHeaders: true,
        legacyHeaders: false,
        // Corre después de requireApiKey: la integración ya está resuelta.
        // Se cuenta por id de key, no por la key en claro: el secreto no tiene
        // por qué quedar de clave en la memoria del rate limiter.
        keyGenerator: (req) => req.integration?.keyId ?? "sin-key",
        handler: (_req, res) =>
          res.status(429).json({
            error: { code: "RATE_LIMITED", message: "Demasiadas consultas. Probá en un minuto." }
          })
      });

const setCache: RequestHandler = (_req, res, next) => {
  // El mismo URL devuelve distintos tenants según X-Api-Key. No cachear en CDN.
  res.set("Cache-Control", "private, no-store");
  next();
};

exportRoutes.use("/export", requireApiKey("export:read"), exportLimiter, setCache);

const estadoFilter = z.enum(ESTADOS);

const exportFilters = z.object({
  operacion: z.enum(["venta", "alquiler"]).optional(),
  tipo: z.enum(TIPOS).optional(),
  estado: estadoFilter.optional(),
  zona: z.string().trim().min(1).optional(),
  ciudad: z.string().trim().min(1).optional(),
  precio_min: z.coerce.number().min(0).optional(),
  precio_max: z.coerce.number().min(0).optional(),
  ambientes: z.coerce.number().int().min(0).optional(),
  dormitorios_min: z.coerce.number().int().min(0).optional(),
  // dormitorios exacto (1..3); 4 = "4 o más". Lo usa el buscador de la web.
  dormitorios: z.coerce.number().int().min(0).optional(),
  // texto libre del buscador natural de la web
  q: z.string().trim().min(1).max(120).optional(),
  updated_since: z.coerce.date().optional(),
  sort: z.enum(["recent", "price-asc", "price-desc"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24)
});

exportRoutes.get("/export/properties", async (req, res) => {
  const f = exportFilters.parse(req.query);
  res.json(
    await exportSvc.listExportProperties(req.integration!.tenantId, {
      operacion: f.operacion,
      tipo: f.tipo,
      estado: f.estado,
      zona: f.zona,
      ciudad: f.ciudad,
      precioMin: f.precio_min,
      precioMax: f.precio_max,
      ambientes: f.ambientes,
      dormitoriosMin: f.dormitorios_min,
      dormitorios: f.dormitorios,
      q: f.q,
      updatedSince: f.updated_since,
      sort: f.sort,
      page: f.page,
      limit: f.limit
    })
  );
});

// Antes de /export/properties/:idOrSlug no hace falta: es otra ruta base.
exportRoutes.get("/export/ciudades", async (req, res) => {
  const { estado } = z.object({ estado: estadoFilter.optional() }).parse(req.query);
  res.json({ data: await exportSvc.listExportCiudades(req.integration!.tenantId, estado) });
});

exportRoutes.get("/export/zonas", async (req, res) => {
  const { estado } = z.object({ estado: estadoFilter.optional() }).parse(req.query);
  res.json({ data: await exportSvc.listExportZonas(req.integration!.tenantId, estado) });
});

exportRoutes.get("/export/properties/:idOrSlug", async (req, res) => {
  const idOrSlug = z.string().trim().min(1).max(200).parse(req.params.idOrSlug);
  res.json({ property: await exportSvc.getExportProperty(req.integration!.tenantId, idOrSlug) });
});

exportRoutes.get("/export/site", async (req, res) => {
  res.json({ site: await exportSvc.getExportSite(req.integration!.tenantId) });
});
