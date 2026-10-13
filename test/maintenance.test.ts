import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Mantenimiento de alquileres", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let propertyA: string;
  let propertyB: string;
  let contractA: string;
  let contractB: string;
  let requestId: string;
  let adminA: ReturnType<typeof request.agent>;
  let adminB: ReturnType<typeof request.agent>;
  let agentA: ReturnType<typeof request.agent>;
  let csrfA: string;

  beforeAll(async () => {
    await truncateAll();
    a = await seedTenantWithUsers("maintenance-a");
    b = await seedTenantWithUsers("maintenance-b");
    const db = adminDb();
    const createData = async (tenantId: string, adminId: string, agentId: string, suffix: string) => {
      const property = await db.property.create({ data: { tenantId, userId: agentId, titulo: `Departamento ${suffix}`,
        slug: `maintenance-${suffix}`, operacion: "alquiler", tipo: "departamento", precio: 400000, moneda: "ARS" } });
      const owner = await db.rentalPerson.create({ data: { tenantId, createdById: adminId,
        nombre: `Dueño ${suffix}`, roles: ["propietario"] } });
      const renter = await db.rentalPerson.create({ data: { tenantId, createdById: adminId,
        nombre: `Inquilino ${suffix}`, roles: ["inquilino"] } });
      const contract = await db.rentalContract.create({ data: { tenantId, propertyId: property.id,
        ownerPersonId: owner.id, tenantPersonId: renter.id, createdById: adminId,
        startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), monthlyRent: "400000",
        currency: "ARS", dueDay: 10 } });
      return { propertyId: property.id, contractId: contract.id };
    };
    ({ propertyId: propertyA, contractId: contractA } = await createData(a.tenant.id, a.admin.id, a.agente.id, "a"));
    ({ propertyId: propertyB, contractId: contractB } = await createData(b.tenant.id, b.admin.id, b.agente.id, "b"));
    adminA = request.agent(app);
    adminB = request.agent(app);
    agentA = request.agent(app);
    csrfA = (await adminA.post("/v1/auth/login").send({ email: a.admin.email, password: TEST_PASSWORD })).body.csrf_token;
    await adminB.post("/v1/auth/login").send({ email: b.admin.email, password: TEST_PASSWORD });
    await agentA.post("/v1/auth/login").send({ email: a.agente.email, password: TEST_PASSWORD });
  });

  const input = () => ({ property_id: propertyA, contract_id: contractA,
    title: "Pérdida de agua", description: "Gotea una canilla de la cocina", priority: "alta",
    note: "Reportado por la inquilina" });

  it("crea y cambia estados con historial", async () => {
    const created = await adminA.post("/v1/maintenance-requests").set("x-csrf-token", csrfA).send(input());
    expect(created.status).toBe(201);
    requestId = created.body.item.id;
    expect(created.body.item.events).toHaveLength(1);
    expect((await adminA.get("/v1/maintenance-requests").query({ property_id: propertyA })).body.meta.total).toBe(1);
    const path = `/v1/maintenance-requests/${requestId}/transition`;
    expect((await adminA.post(path).set("x-csrf-token", csrfA)
      .send({ status: "resuelta", note: "Sin revisión" })).status).toBe(409);
    expect((await adminA.post(path).set("x-csrf-token", csrfA)
      .send({ status: "en_gestion", note: "Se coordinó plomero" })).status).toBe(200);
    expect((await adminA.post(path).set("x-csrf-token", csrfA)
      .send({ status: "resuelta", note: "Se reemplazó la canilla" })).status).toBe(200);
    const detail = await adminA.get(`/v1/maintenance-requests/${requestId}`);
    expect(detail.body.item.events.map((event: { toState: string }) => event.toState))
      .toEqual(["resuelta", "en_gestion", "abierta"]);
    expect(detail.body.item.resolvedAt).toBeTruthy();
  });

  it("impide cruzar propiedades, contratos y tenants", async () => {
    const create = (body: object) => adminA.post("/v1/maintenance-requests").set("x-csrf-token", csrfA).send(body);
    expect((await create({ ...input(), property_id: propertyB })).status).toBe(404);
    expect((await create({ ...input(), contract_id: contractB })).status).toBe(404);
    expect((await adminB.get(`/v1/maintenance-requests/${requestId}`)).status).toBe(404);
    expect((await agentA.get("/v1/maintenance-requests")).status).toBe(403);
    expect((await request(app).get("/v1/maintenance-requests")).status).toBe(401);
    expect(await runWithContext({ tenantId: b.tenant.id, userId: b.admin.id, rol: "admin" },
      (tx) => tx.maintenanceRequest.findMany())).toHaveLength(0);
    await expect(adminDb().maintenanceRequest.create({ data: {
      tenantId: a.tenant.id, propertyId: propertyB, contractId: contractA,
      createdById: a.admin.id, title: "Fallo", description: "Fallo", priority: "normal"
    } })).rejects.toThrow();
  });
});
