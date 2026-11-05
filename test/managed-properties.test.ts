import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";
describe.runIf(DB_AVAILABLE)("Propiedades administradas", () => {
  const app = buildApp(); const admin = request.agent(app), other = request.agent(app);
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: typeof a; let csrf: string; let propertyId: string;
  beforeAll(async () => {
    await truncateAll(); a = await seedTenantWithUsers("managed-a"); b = await seedTenantWithUsers("managed-b");
    csrf = (await admin.post("/v1/auth/login").send({ email: a.admin.email, password: TEST_PASSWORD })).body.csrf_token;
    await other.post("/v1/auth/login").send({ email: b.admin.email, password: TEST_PASSWORD });
  });
  it("crea inventario administrativo oculto de web, export y agente incluso si cambia el estado comercial", async () => {
    const created = await admin.post("/v1/rental-properties").set("x-csrf-token", csrf).send({ titulo: "Administración interna", direccion: "Dirección de prueba 123", tipo: "casa" });
    expect(created.status).toBe(201); propertyId = created.body.property.id;
    expect(created.body.property.administrationOnly).toBe(true);
    expect((await admin.get("/v1/rental-properties?q=interna")).body.meta.total).toBe(1);
    expect((await other.get("/v1/rental-properties")).body.meta.total).toBe(0);
    await adminDb().property.update({ where: { id: propertyId }, data: { estado: "disponible" } });
    for (const rol of ["public", "export", "agent"] as const) {
      expect(await runWithContext({ tenantId: a.tenant.id, rol }, tx => tx.property.findUnique({ where: { id: propertyId } }))).toBeNull();
    }
    expect(await runWithContext({ tenantId: b.tenant.id, userId: b.admin.id, rol: "admin" }, tx => tx.property.findUnique({ where: { id: propertyId } }))).toBeNull();
  });
  it("incorpora una propiedad de venta conservando publicación y permite vincularla al contrato", async () => {
    const db = adminDb();
    const sale = await db.property.create({ data: { tenantId: a.tenant.id, userId: a.admin.id, titulo: "Venta administrada", slug: "managed-sale", tipo: "casa", operacion: "venta", precio: 100, moneda: "USD" } });
    expect((await admin.post(`/v1/rental-properties/${sale.id}/manage`).set("x-csrf-token", csrf)).status).toBe(200);
    const saved = await db.property.findUniqueOrThrow({ where: { id: sale.id } });
    expect(saved.operacion).toBe("venta"); expect(saved.estado).toBe("disponible"); expect(saved.administrationOnly).toBe(false);
    const owner = await db.rentalPerson.create({ data: { tenantId: a.tenant.id, createdById: a.admin.id, nombre: "Dueño", roles: ["propietario"] } });
    const tenant = await db.rentalPerson.create({ data: { tenantId: a.tenant.id, createdById: a.admin.id, nombre: "Inquilino", roles: ["inquilino"] } });
    const contract = await admin.post("/v1/rental-contracts").set("x-csrf-token", csrf).send({ property_id: sale.id, owner_person_id: owner.id, tenant_person_id: tenant.id, start_date: "2025-01-01", end_date: "2028-12-31", monthly_rent: "1000", currency: "ARS", due_day: 10 });
    expect(contract.status).toBe(201);
    const id = contract.body.contract.id;
    await db.rentalAdjustment.createMany({ data: [{ tenantId: a.tenant.id, contractId: id, createdById: a.admin.id, effectivePeriod: new Date("2025-02-01"), amount: 1500, reason: "Anterior" }, { tenantId: a.tenant.id, contractId: id, createdById: a.admin.id, effectivePeriod: new Date("2028-12-01"), amount: 2000, reason: "Futuro" }] });
    const detail = await admin.get(`/v1/rental-contracts/${id}`);
    expect(detail.body.contract.monthlyRent).toBe("1000"); expect(detail.body.contract.currentRent).toBe("1500");
    const list = await admin.get("/v1/rental-contracts?q=Venta");
    expect(list.body.data[0].currentRent).toBe("1500");
    expect(await db.rentalCharge.count({ where: { contractId: id } })).toBe(0);
  });
  it("encuentra propiedades fuera de la primera página", async () => {
    await adminDb().property.createMany({ data: Array.from({ length: 25 }, (_, i) => ({ tenantId: a.tenant.id, userId: a.admin.id, titulo: `Cartera ${i}`, slug: `managed-${i}`, managed: true, administrationOnly: true, tipo: "casa", operacion: "alquiler" as const, precio: 0, moneda: "ARS" as const })) });
    expect((await admin.get("/v1/rental-properties?page=2")).body.data.length).toBeGreaterThan(0);
    expect((await admin.get("/v1/rental-properties?q=Cartera%2024")).body.meta.total).toBe(1);
  });
});
