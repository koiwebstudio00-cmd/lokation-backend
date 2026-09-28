import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import * as tenants from "./service.js";

export const tenantRoutes = Router();

tenantRoutes.use("/tenants", requireAuth);

tenantRoutes.get("/tenants", requireRole("super_admin"), async (req, res) => {
  res.json({ data: await tenants.listTenants(req.auth!) });
});

tenantRoutes.post("/tenants", requireRole("super_admin"), async (req, res) => {
  const body = z
    .object({
      nombre: z.string().min(1),
      slug: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{1,48}$/, "Slug inválido (minúsculas, números y guiones)."),
      admin_email: z.string().email()
    })
    .parse(req.body);
  const tenant = await tenants.createTenant(req.auth!, {
    nombre: body.nombre,
    slug: body.slug,
    adminEmail: body.admin_email
  });
  res.status(201).json({ tenant });
});

tenantRoutes.get(
  "/tenants/current",
  requireRole("admin", "agente"),
  async (req, res) => {
    res.json({ tenant: await tenants.currentTenant(req.auth!) });
  }
);

tenantRoutes.patch("/tenants/current", requireRole("admin"), async (req, res) => {
  const body = z
    .object({
      logo_url: z.string().url().nullable().optional(),
      config_sitio: z.record(z.unknown()).optional(),
      agente_activo: z.boolean().optional(),
      seguimiento_activo: z.boolean().optional(),
      seguimiento_mensaje_1: z.string().trim().min(1).max(1000).optional(),
      seguimiento_mensaje_2: z.string().trim().min(1).max(1000).optional()
    })
    .parse(req.body);
  const tenant = await tenants.updateCurrentTenant(req.auth!, {
    logoUrl: body.logo_url,
    configSitio: body.config_sitio,
    agentEnabled: body.agente_activo,
    followupEnabled: body.seguimiento_activo,
    followupFirstMessage: body.seguimiento_mensaje_1,
    followupSecondMessage: body.seguimiento_mensaje_2
  });
  res.json({ tenant });
});

tenantRoutes.patch("/tenants/:id", requireRole("super_admin"), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const body = z.object({ estado: z.enum(["activo", "suspendido"]) }).parse(req.body);
  const tenant = await tenants.setTenantEstado(req.auth!, id, body.estado);
  res.json({ tenant });
});
