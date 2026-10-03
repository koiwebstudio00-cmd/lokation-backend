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
  const result = await tenants.createTenant(req.auth!, {
    nombre: body.nombre,
    slug: body.slug,
    adminEmail: body.admin_email
  });
  res.status(201).json({ tenant: result.tenant, ...(result.devInvitationUrl
    ? { dev_invitation_url: result.devInvitationUrl } : {}) });
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
      nombre: z.string().trim().min(2).max(120).optional(),
      config_sitio: z.object({
        descripcion: z.string().trim().min(30).max(500),
        telefono: z.string().trim().max(40).optional(),
        email: z.union([z.string().email().max(254), z.literal("")]).optional(),
        direccion: z.string().trim().max(200).optional(),
        ciudad: z.string().trim().max(100).optional(),
        imagen_portada_url: z.union([z.string().url(), z.literal("")]).optional(),
        lema: z.string().trim().max(100).optional(),
        color_primario: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Elegí un color hexadecimal válido.").optional()
      }).strict().optional(),
      website_mode: z.enum(["managed", "custom"]).optional(),
      site_published: z.boolean().optional(),
      agent_config: z.object({
        model: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/, "Identificador de modelo OpenAI inválido."),
        instructions: z.string().trim().min(20).max(6000)
      }).strict().optional(),
      agente_activo: z.boolean().optional(),
      seguimiento_activo: z.boolean().optional(),
      seguimiento_mensaje_1: z.string().trim().min(1).max(1000).optional(),
      seguimiento_mensaje_2: z.string().trim().min(1).max(1000).optional()
    })
    .parse(req.body);
  const tenant = await tenants.updateCurrentTenant(req.auth!, {
    logoUrl: body.logo_url,
    nombre: body.nombre,
    configSitio: body.config_sitio,
    sitePublished: body.site_published,
    websiteMode: body.website_mode,
    agentConfig: body.agent_config,
    agentEnabled: body.agente_activo,
    followupEnabled: body.seguimiento_activo,
    followupFirstMessage: body.seguimiento_mensaje_1,
    followupSecondMessage: body.seguimiento_mensaje_2
  });
  res.json({ tenant });
});

tenantRoutes.post("/tenants/:id/resend-invitation", requireRole("super_admin"), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const result = await tenants.resendTenantInvitation(req.auth!, id);
  res.json({ email: result.email, ...(result.devInvitationUrl
    ? { dev_invitation_url: result.devInvitationUrl } : {}) });
});

tenantRoutes.patch("/tenants/:id", requireRole("super_admin"), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const body = z.object({ estado: z.enum(["activo", "suspendido"]) }).parse(req.body);
  const tenant = await tenants.setTenantEstado(req.auth!, id, body.estado);
  res.json({ tenant });
});
