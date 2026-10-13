import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Personas de alquiler", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let adminA: ReturnType<typeof request.agent>;
  let adminB: ReturnType<typeof request.agent>;
  let agentA: ReturnType<typeof request.agent>;
  let csrfA: string;
  let csrfB: string;
  let personId: string;

  beforeAll(async () => {
    await truncateAll();
    a = await seedTenantWithUsers("rental-a");
    b = await seedTenantWithUsers("rental-b");
    adminA = request.agent(app);
    adminB = request.agent(app);
    agentA = request.agent(app);
    csrfA = (await adminA.post("/v1/auth/login").send({ email: a.admin.email, password: TEST_PASSWORD })).body.csrf_token;
    csrfB = (await adminB.post("/v1/auth/login").send({ email: b.admin.email, password: TEST_PASSWORD })).body.csrf_token;
    await agentA.post("/v1/auth/login").send({ email: a.agente.email, password: TEST_PASSWORD });
  });

  it("crea, lista y modifica una persona sin exponerla públicamente", async () => {
    const created = await adminA.post("/v1/rental-people").set("x-csrf-token", csrfA).send({
      nombre: "Ana Alquiler", email: "ana@example.test", roles: ["propietario", "inquilino"]
    });
    expect(created.status).toBe(201);
    personId = created.body.person.id;
    expect(created.body.person.tenantId).toBe(a.tenant.id);
    const listed = await adminA.get("/v1/rental-people?q=Ana");
    expect(listed.body.meta.total).toBe(1);
    const updated = await adminA.patch(`/v1/rental-people/${personId}`).set("x-csrf-token", csrfA)
      .send({ telefono: "381-555-0100" });
    expect(updated.status).toBe(200);
    expect(updated.body.person.telefono).toBe("381-555-0100");
    expect((await request(app).get(`/v1/rental-people/${personId}`)).status).toBe(401);
  });

  it("rechaza roles duplicados y campos ajenos", async () => {
    expect((await adminA.post("/v1/rental-people").set("x-csrf-token", csrfA)
      .send({ nombre: "B", roles: ["inquilino", "inquilino"] })).status).toBe(400);
    expect((await adminA.post("/v1/rental-people").set("x-csrf-token", csrfA)
      .send({ nombre: "B", roles: ["inquilino"], tenantId: b.tenant.id })).status).toBe(400);
  });

  it("aísla lectura y escritura entre tenants y limita el acceso a admins", async () => {
    expect((await adminB.get("/v1/rental-people")).body.meta.total).toBe(0);
    expect((await adminB.get(`/v1/rental-people/${personId}`)).status).toBe(404);
    expect((await adminB.patch(`/v1/rental-people/${personId}`).set("x-csrf-token", csrfB)
      .send({ nombre: "Cambio cruzado" })).status).toBe(404);
    expect((await agentA.get("/v1/rental-people")).status).toBe(403);
    const rows = await runWithContext({ tenantId: b.tenant.id, userId: b.admin.id, rol: "admin" },
      (tx) => tx.rentalPerson.findMany());
    expect(rows).toHaveLength(0);
    expect((await adminA.get(`/v1/rental-people/${personId}`)).body.person.nombre).toBe("Ana Alquiler");
  });
});
