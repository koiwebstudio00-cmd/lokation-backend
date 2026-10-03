import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, truncateAll } from "./helpers.js";
describe.runIf(DB_AVAILABLE)("Consulta desde ficha pública", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: typeof a;
  let property: { id: string; slug: string };
  beforeAll(async () => {
    await truncateAll();
    a = await seedTenantWithUsers("ficha-a"); b = await seedTenantWithUsers("ficha-b");
    await adminDb().tenant.updateMany({ data: { sitePublished: true } });
    property = await adminDb().property.create({ data: { tenantId: a.tenant.id, userId: a.agente.id,
      titulo: "Casa ficha A", tipo: "casa", operacion: "venta", precio: 120000 } });
  });
  const body = () => ({ property_slug: property.slug, nombre: "Visitante", email: "visitante@example.test", mensaje: "Quiero conocer esta casa." });
  it("guarda la propiedad, asigna su agente y notifica dentro de la inmobiliaria", async () => {
    const res = await request(app).post("/v1/public/ficha-a/leads").send(body());
    expect(res.status).toBe(201);
    const lead = await adminDb().lead.findUniqueOrThrow({ where: { id: res.body.lead_id } });
    expect(lead.propertyId).toBe(property.id); expect(lead.tenantId).toBe(a.tenant.id);
    expect(lead.assignedTo).toBe(a.agente.id);
    const notices = await adminDb().notification.findMany({ where: { href: `/consultas/${lead.id}` } });
    expect(notices.map(n => n.userId).sort()).toEqual([a.admin.id,a.agente.id].sort());
  });
  it("rechaza otra inmobiliaria, slug inexistente e identificadores contradictorios", async () => {
    const count = await adminDb().lead.count();
    expect((await request(app).post("/v1/public/ficha-b/leads").send(body())).status).toBe(404);
    expect((await request(app).post("/v1/public/ficha-a/leads").send({ ...body(), property_slug: "no-existe" })).status).toBe(404);
    expect((await request(app).post("/v1/public/ficha-a/leads").send({ ...body(), property_id: b.tenant.id })).status).toBe(404);
    expect(await adminDb().lead.count()).toBe(count);
  });
  it("rechaza propiedades no disponibles y sitios ocultos", async () => {
    const count = await adminDb().lead.count();
    await adminDb().property.update({ where: { id: property.id }, data: { estado: "privado" } });
    expect((await request(app).post("/v1/public/ficha-a/leads").send(body())).status).toBe(404);
    await adminDb().property.update({ where: { id: property.id }, data: { estado: "disponible" } });
    await adminDb().tenant.update({ where: { id: a.tenant.id }, data: { sitePublished: false } });
    expect((await request(app).post("/v1/public/ficha-a/leads").send(body())).status).toBe(404);
    expect(await adminDb().lead.count()).toBe(count);
  });
});
