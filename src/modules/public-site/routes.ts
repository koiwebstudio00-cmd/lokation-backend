import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { runWithContext } from "../../lib/prisma.js";

export const publicSiteRoutes = Router();

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/);
const propertySlugSchema = z.string().regex(/^[a-z0-9-]{1,200}$/);
const PUBLIC_PROPERTY_SELECT = {
  slug: true, titulo: true, descripcion: true, operacion: true, tipo: true,
  precio: true, moneda: true, precioAlquiler: true, monedaAlquiler: true,
  ciudad: true, zona: true, direccion: true, ambientes: true, dormitorios: true,
  banios: true, supCubierta: true, supTotal: true, destacada: true,
  images: { select: { url: true, esPortada: true, orden: true }, orderBy: { orden: "asc" as const } }
} as const;

async function publishedSite(slug: string) {
  const tenant = await runWithContext({ rol: "auth" }, (tx) => tx.tenant.findUnique({
    where: { slug },
    select: { id: true, nombre: true, slug: true, logoUrl: true, configSitio: true,
      estado: true, sitePublished: true }
  }));
  if (!tenant || tenant.estado !== "activo" || !tenant.sitePublished) {
    throw new ApiError("NOT_FOUND", "El sitio no está disponible.");
  }
  const raw = tenant.configSitio && typeof tenant.configSitio === "object" && !Array.isArray(tenant.configSitio)
    ? tenant.configSitio as Record<string, unknown> : {};
  const field = (key: string) => typeof raw[key] === "string" ? raw[key] as string : null;
  return { id: tenant.id, public: {
    nombre: tenant.nombre, slug: tenant.slug, logo_url: tenant.logoUrl,
    descripcion: field("descripcion"), telefono: field("telefono"), email: field("email"),
    direccion: field("direccion"), ciudad: field("ciudad"),
    imagen_portada_url: field("imagen_portada_url")
  } };
}

publicSiteRoutes.use("/public/sites", (_req, res, next) => {
  // La suspensión o despublicación debe ocultar el sitio en el próximo request.
  res.set("Cache-Control", "no-store");
  next();
});

publicSiteRoutes.get("/public/sites", async (_req, res) => {
  const sites = await runWithContext({ rol: "auth" }, (tx) => tx.tenant.findMany({
    where: { sitePublished: true, estado: "activo" },
    select: { slug: true }, orderBy: { slug: "asc" }
  }));
  res.json({ data: sites });
});

publicSiteRoutes.get("/public/sites/:slug", async (req, res) => {
  const site = await publishedSite(slugSchema.parse(req.params.slug));
  res.json({ site: site.public });
});

publicSiteRoutes.get("/public/sites/:slug/properties", async (req, res) => {
  const site = await publishedSite(slugSchema.parse(req.params.slug));
  const properties = await runWithContext({ tenantId: site.id, rol: "public" }, (tx) =>
    tx.property.findMany({ where: { estado: "disponible" }, select: PUBLIC_PROPERTY_SELECT,
      orderBy: [{ destacada: "desc" }, { createdAt: "desc" }] })
  );
  res.json({ data: properties });
});

publicSiteRoutes.get("/public/sites/:slug/export", async (req, res) => {
  const site = await publishedSite(slugSchema.parse(req.params.slug));
  const properties = await runWithContext({ tenantId: site.id, rol: "public" }, (tx) =>
    tx.property.findMany({ where: { estado: "disponible" }, select: PUBLIC_PROPERTY_SELECT,
      orderBy: [{ destacada: "desc" }, { createdAt: "desc" }] })
  );
  res.set("Content-Disposition", `attachment; filename="${site.public.slug}-catalogo.json"`);
  res.json({ exported_at: new Date().toISOString(), site: site.public, properties });
});

publicSiteRoutes.get("/public/sites/:slug/properties/:propertySlug", async (req, res) => {
  const site = await publishedSite(slugSchema.parse(req.params.slug));
  const propertySlug = propertySlugSchema.parse(req.params.propertySlug);
  const property = await runWithContext({ tenantId: site.id, rol: "public" }, (tx) =>
    tx.property.findFirst({ where: { slug: propertySlug, estado: "disponible" },
      select: PUBLIC_PROPERTY_SELECT })
  );
  if (!property) throw new ApiError("NOT_FOUND", "El recurso no existe.");
  res.json({ property });
});
