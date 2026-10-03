import { config } from "../src/config.js";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { adminDb, DB_AVAILABLE, seedSuperAdmin, seedTenantWithUsers,
  TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Alta y sitio público por inmobiliaria", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let adminA: ReturnType<typeof request.agent>;
  let csrfA = "";
  let aSlug = "";
  let bSlug = "";

  beforeAll(async () => {
    await truncateAll();
    a = await seedTenantWithUsers("publica-a");
    b = await seedTenantWithUsers("publica-b");
    await seedSuperAdmin();
    adminA = request.agent(app);
    const login = await adminA.post("/v1/auth/login").send({ email: a.admin.email,
      password: TEST_PASSWORD });
    csrfA = login.body.csrf_token;
    const propertyA = await adminDb().property.create({ data: {
      tenantId: a.tenant.id, userId: a.admin.id, titulo: "Casa A", operacion: "venta",
      tipo: "casa", precio: 100000, notas: "Secreto A" } });
    const propertyB = await adminDb().property.create({ data: {
      tenantId: b.tenant.id, userId: b.admin.id, titulo: "Casa B", operacion: "venta",
      tipo: "casa", precio: 200000, notas: "Secreto B" } });
    aSlug = propertyA.slug;
    bSlug = propertyB.slug;
  });

  it("guarda el modo de web por tenant sin publicar", async () => {
    const response = await adminA.patch("/v1/tenants/current").set("x-csrf-token", csrfA)
      .send({ website_mode: "custom" });
    expect(response.status).toBe(200);
    expect(response.body.tenant.configSitio.website_mode).toBe("custom");
    expect(response.body.tenant.sitePublished).toBe(false);
    const other = await adminDb().tenant.findUniqueOrThrow({ where: { id: b.tenant.id } });
    expect(other.configSitio ?? {}).not.toHaveProperty("website_mode", "custom");
    expect((await adminA.patch("/v1/tenants/current").set("x-csrf-token", csrfA)
      .send({ website_mode: "invalid" })).status).toBe(400);
    const agent = request.agent(app);
    const login = await agent.post("/v1/auth/login").send({ email: a.agente.email, password: TEST_PASSWORD });
    expect((await agent.patch("/v1/tenants/current").set("x-csrf-token", login.body.csrf_token)
      .send({ website_mode: "managed" })).status).toBe(403);
  });

  it("super admin registra un tenant e invita al primer admin", async () => {
    const operator = request.agent(app);
    const login = await operator.post("/v1/auth/login").send({ email: "super@test.test",
      password: TEST_PASSWORD });
    const created = await operator.post("/v1/tenants").set("x-csrf-token", login.body.csrf_token)
      .send({ nombre: "Nueva Inmo", slug: "nueva-inmo", admin_email: "nueva@test.test" });
    expect(created.status).toBe(201);
    expect(created.body.tenant.sitePublished).toBe(false);
    expect(created.body.dev_invitation_url).toContain("/aceptar-invitacion?token=");
    expect(await adminDb().invitation.count({ where: { tenantId: created.body.tenant.id } })).toBe(1);
    expect((await request(app).get("/v1/public/sites")).body.data).not.toContainEqual({ slug: "nueva-inmo" });
    const renewed = await operator.post(`/v1/tenants/${created.body.tenant.id}/resend-invitation`)
      .set("x-csrf-token", login.body.csrf_token).send({});
    expect(renewed.status).toBe(200);
    expect(renewed.body.dev_invitation_url).not.toBe(created.body.dev_invitation_url);
    expect(await adminDb().invitation.count({ where: { tenantId: created.body.tenant.id } })).toBe(1);
    const oldToken = new URL(created.body.dev_invitation_url).searchParams.get("token");
    const newToken = new URL(renewed.body.dev_invitation_url).searchParams.get("token");
    expect((await request(app).post("/v1/auth/accept-invitation").send({ token: oldToken,
      nombre: "Admin Nueva", password: TEST_PASSWORD })).status).toBe(401);
    const accepted = await request(app).post("/v1/auth/accept-invitation").send({ token: newToken,
      nombre: "Admin Nueva", password: TEST_PASSWORD });
    expect(accepted.status).toBe(201);
    expect(accepted.body.user.tenant.slug).toBe("nueva-inmo");
  });

  it("Resend rechazado revierte el alta y no expone un enlace de desarrollo", async () => {
    const original = config.RESEND_API_KEY;
    const operator = request.agent(app);
    const login = await operator.post("/v1/auth/login").send({ email: "super@test.test", password: TEST_PASSWORD });
    config.RESEND_API_KEY = "test-only";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rejected", { status: 403 })));
    try {
      const response = await operator.post("/v1/tenants").set("x-csrf-token", login.body.csrf_token)
        .send({ nombre: "Correo fallido", slug: "correo-fallido", admin_email: "correo@example.test" });
      expect(response.status).toBe(500);
      expect(response.body.dev_invitation_url).toBeUndefined();
      expect(await adminDb().tenant.findUnique({ where: { slug: "correo-fallido" } })).toBeNull();
    } finally { config.RESEND_API_KEY = original; vi.unstubAllGlobals(); }
  });

  it("un sitio empieza oculto y exige descripción antes de publicar", async () => {
    expect((await request(app).get("/v1/public/sites/publica-a")).status).toBe(404);
    const invalid = await adminA.patch("/v1/tenants/current").set("x-csrf-token", csrfA)
      .send({ site_published: true });
    expect(invalid.status).toBe(409);
    const saved = await adminA.patch("/v1/tenants/current").set("x-csrf-token", csrfA).send({
      nombre: "Inmo A renovada", site_published: true,
      config_sitio: { descripcion: "Ofrecemos propiedades seleccionadas en Tucumán y alrededores.",
        email: "contacto@a.test", lema: "Tu próximo lugar empieza acá",
        color_primario: "#1b5148" } });
    expect(saved.status).toBe(200);
    expect(saved.body.tenant.sitePublished).toBe(true);
  });

  it("publica solo el catálogo propio y sin notas internas", async () => {
    const site = await request(app).get("/v1/public/sites/publica-a");
    expect(site.status).toBe(200);
    expect(site.body.site.nombre).toBe("Inmo A renovada");
    expect(site.body.site.lema).toBe("Tu próximo lugar empieza acá");
    expect(site.body.site.color_primario).toBe("#1b5148");
    const list = await request(app).get("/v1/public/sites/publica-a/properties");
    expect(list.body.data.map((property: { titulo: string }) => property.titulo)).toEqual(["Casa A"]);
    expect(JSON.stringify(list.body)).not.toMatch(/Secreto|notas|tenantId|userId/);
    expect((await request(app).get(`/v1/public/sites/publica-a/properties/${bSlug}`)).status).toBe(404);
    expect((await request(app).get(`/v1/public/sites/publica-a/properties/${aSlug}`)).status).toBe(200);
    const exported = await request(app).get("/v1/public/sites/publica-a/export");
    expect(exported.status).toBe(200);
    expect(exported.body.properties).toHaveLength(1);
    expect(exported.headers["content-disposition"]).toContain("publica-a-catalogo.json");
  });

  it("valida la identidad visual y permite quitar datos de contacto", async () => {
    const invalid = await adminA.patch("/v1/tenants/current").set("x-csrf-token", csrfA).send({
      config_sitio: { descripcion: "Ofrecemos propiedades seleccionadas en Tucumán y alrededores.",
        color_primario: "red" } });
    expect(invalid.status).toBe(400);
    const updated = await adminA.patch("/v1/tenants/current").set("x-csrf-token", csrfA).send({
      config_sitio: { descripcion: "Ofrecemos propiedades seleccionadas en Tucumán y alrededores.",
        email: "", lema: "", color_primario: "#275c73" } });
    expect(updated.status).toBe(200);
    const site = await request(app).get("/v1/public/sites/publica-a");
    expect(site.body.site.email).toBeNull();
    expect(site.body.site.lema).toBeNull();
    expect(site.body.site.color_primario).toBe("#275c73");
  });

  it("la inmobiliaria B sigue oculta y una suspensión oculta A", async () => {
    expect((await request(app).get("/v1/public/sites/publica-b")).status).toBe(404);
    await adminDb().tenant.update({ where: { id: a.tenant.id }, data: { estado: "suspendido" } });
    expect((await request(app).get("/v1/public/sites/publica-a")).status).toBe(404);
    expect((await request(app).get("/v1/public/sites/publica-a/export")).status).toBe(404);
  });
});
