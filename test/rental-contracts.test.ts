import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Borradores de contrato de alquiler", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let rentalA: string;
  let saleA: string;
  let rentalB: string;
  let ownerA: string;
  let tenantA: string;
  let wrongRoleA: string;
  let ownerB: string;
  let adminA: ReturnType<typeof request.agent>;
  let adminB: ReturnType<typeof request.agent>;
  let agentA: ReturnType<typeof request.agent>;
  let csrfA: string;
  let contractId: string;

  const body = () => ({
    property_id: rentalA, owner_person_id: ownerA, tenant_person_id: tenantA,
    start_date: "2026-11-01", end_date: "2028-10-31",
    monthly_rent: "420000.00", currency: "ARS", due_day: 10
  });

  beforeAll(async () => {
    await truncateAll();
    a = await seedTenantWithUsers("contract-a");
    b = await seedTenantWithUsers("contract-b");
    const db = adminDb();
    const makeProperty = (tenantId: string, userId: string, slug: string, operacion: "venta" | "alquiler") =>
      db.property.create({ data: { tenantId, userId, titulo: slug, slug, operacion,
        tipo: "departamento", precio: 420000, moneda: "ARS" } });
    rentalA = (await makeProperty(a.tenant.id, a.agente.id, "contract-rental-a", "alquiler")).id;
    saleA = (await makeProperty(a.tenant.id, a.agente.id, "contract-sale-a", "venta")).id;
    rentalB = (await makeProperty(b.tenant.id, b.agente.id, "contract-rental-b", "alquiler")).id;
    const makePerson = (tenantId: string, createdById: string, nombre: string, role: "propietario" | "inquilino") =>
      db.rentalPerson.create({ data: { tenantId, createdById, nombre, roles: [role] } });
    ownerA = (await makePerson(a.tenant.id, a.admin.id, "Dueña A", "propietario")).id;
    tenantA = (await makePerson(a.tenant.id, a.admin.id, "Inquilina A", "inquilino")).id;
    wrongRoleA = (await makePerson(a.tenant.id, a.admin.id, "Otra inquilina A", "inquilino")).id;
    ownerB = (await makePerson(b.tenant.id, b.admin.id, "Dueño B", "propietario")).id;
    adminA = request.agent(app);
    adminB = request.agent(app);
    agentA = request.agent(app);
    csrfA = (await adminA.post("/v1/auth/login").send({ email: a.admin.email, password: TEST_PASSWORD })).body.csrf_token;
    await adminB.post("/v1/auth/login").send({ email: b.admin.email, password: TEST_PASSWORD });
    await agentA.post("/v1/auth/login").send({ email: a.agente.email, password: TEST_PASSWORD });
  });

  it("crea un borrador con importe decimal, partes y fechas sin cambiar la publicación", async () => {
    const created = await adminA.post("/v1/rental-contracts").set("x-csrf-token", csrfA).send(body());
    expect(created.status).toBe(201);
    contractId = created.body.contract.id;
    expect(created.body.contract).toEqual(expect.objectContaining({
      tenantId: a.tenant.id, status: "borrador", monthlyRent: "420000", dueDay: 10
    }));
    expect(created.body.contract.owner.nombre).toBe("Dueña A");
    expect(created.body.contract.tenantPerson.nombre).toBe("Inquilina A");
    expect((await adminDb().property.findUniqueOrThrow({ where: { id: rentalA } })).estado).toBe("disponible");
    const listed = await adminA.get("/v1/rental-contracts");
    expect(listed.body.meta.total).toBe(1);
    expect((await adminA.get(`/v1/rental-contracts/${contractId}`)).status).toBe(200);
  });

  it("rechaza fechas, importes, roles y propiedades incompatibles", async () => {
    const send = (input: object) => adminA.post("/v1/rental-contracts").set("x-csrf-token", csrfA).send(input);
    expect((await send({ ...body(), end_date: "2026-10-01" })).status).toBe(400);
    expect((await send({ ...body(), start_date: "2026-02-30" })).status).toBe(400);
    expect((await send({ ...body(), monthly_rent: "0" })).status).toBe(400);
    expect((await send({ ...body(), due_day: 31 })).status).toBe(400);
    expect((await send({ ...body(), property_id: saleA })).status).toBe(400);
    expect((await send({ ...body(), owner_person_id: wrongRoleA })).status).toBe(400);
    expect((await send({ ...body(), tenant_person_id: ownerA })).status).toBe(400);
  });

  it("impide mezclar tenants en API, FK de base y lectura RLS", async () => {
    const send = (input: object) => adminA.post("/v1/rental-contracts").set("x-csrf-token", csrfA).send(input);
    expect((await send({ ...body(), owner_person_id: ownerB })).status).toBe(404);
    expect((await send({ ...body(), property_id: rentalB })).status).toBe(404);
    expect((await adminB.get(`/v1/rental-contracts/${contractId}`)).status).toBe(404);
    expect((await adminB.get("/v1/rental-contracts")).body.meta.total).toBe(0);
    expect((await agentA.get("/v1/rental-contracts")).status).toBe(403);
    expect((await request(app).get("/v1/rental-contracts")).status).toBe(401);
    expect(await runWithContext({ tenantId: b.tenant.id, userId: b.admin.id, rol: "admin" },
      (tx) => tx.rentalContract.findMany())).toHaveLength(0);
    await expect(adminDb().rentalContract.create({ data: {
      tenantId: a.tenant.id, propertyId: rentalA, ownerPersonId: ownerB,
      tenantPersonId: tenantA, createdById: a.admin.id,
      startDate: new Date("2026-11-01"), endDate: new Date("2028-10-31"),
      monthlyRent: "420000", currency: "ARS", dueDay: 10
    } })).rejects.toThrow();
  });

  it("edita, activa y finaliza con historial sin permitir dos vigentes en la misma propiedad", async () => {
    const edited = await adminA.patch(`/v1/rental-contracts/${contractId}`).set("x-csrf-token", csrfA)
      .send({ start_date: "2026-01-01", end_date: "2027-12-31", monthly_rent: "450000.25" });
    expect(edited.status).toBe(200);
    expect(edited.body.contract.monthlyRent).toBe("450000.25");
    const second = await adminA.post("/v1/rental-contracts").set("x-csrf-token", csrfA)
      .send({ ...body(), start_date: "2026-01-01", end_date: "2027-12-31" });
    expect(second.status).toBe(201);
    const secondId = second.body.contract.id;

    const missingNote = await adminA.post(`/v1/rental-contracts/${contractId}/activate`)
      .set("x-csrf-token", csrfA).send({ note: "" });
    expect(missingNote.status).toBe(400);
    const activated = await adminA.post(`/v1/rental-contracts/${contractId}/activate`)
      .set("x-csrf-token", csrfA).send({ note: "Contrato en papel verificado" });
    expect(activated.status).toBe(200);
    expect(activated.body.contract.status).toBe("vigente");
    expect((await adminA.patch(`/v1/rental-contracts/${contractId}`).set("x-csrf-token", csrfA)
      .send({ monthly_rent: "999999" })).status).toBe(409);

    const duplicate = await adminA.post(`/v1/rental-contracts/${secondId}/activate`)
      .set("x-csrf-token", csrfA).send({ note: "Segundo contrato de prueba" });
    expect(duplicate.status).toBe(409);

    const finished = await adminA.post(`/v1/rental-contracts/${contractId}/finish`)
      .set("x-csrf-token", csrfA).send({ note: "Entrega de llaves registrada" });
    expect(finished.status).toBe(200);
    expect(finished.body.contract.status).toBe("finalizado");
    expect(finished.body.contract.closedAt).toBeTruthy();
    expect((await adminA.post(`/v1/rental-contracts/${contractId}/finish`).set("x-csrf-token", csrfA)
      .send({ note: "Intento duplicado" })).status).toBe(409);

    const detail = await adminA.get(`/v1/rental-contracts/${contractId}`);
    expect(detail.body.contract.events.map((event: { action: string }) => event.action)).toEqual([
      "finished", "activated", "edited"
    ]);
    expect((await adminB.get(`/v1/rental-contracts/${contractId}`)).status).toBe(404);
    expect((await adminA.post(`/v1/rental-contracts/${secondId}/activate`).set("x-csrf-token", csrfA)
      .send({ note: "Contrato reemplazante" })).status).toBe(200);
  });
});
