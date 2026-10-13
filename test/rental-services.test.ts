import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Cuentas de servicios de alquiler", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let propertyA: string;
  let propertyB: string;
  let saleA: string;
  let adminA: ReturnType<typeof request.agent>;
  let adminB: ReturnType<typeof request.agent>;
  let agentA: ReturnType<typeof request.agent>;
  let csrfA: string;
  const input = { type: "luz", provider: "EDET", account_number: "001234", visibility: "ambos" };

  beforeAll(async () => {
    await truncateAll();
    a = await seedTenantWithUsers("services-a");
    b = await seedTenantWithUsers("services-b");
    const db = adminDb();
    const create = (tenantId: string, userId: string, slug: string, operacion: "alquiler" | "venta") =>
      db.property.create({ data: { tenantId, userId, titulo: slug, slug, operacion,
        tipo: "departamento", precio: 400000, moneda: "ARS" } });
    propertyA = (await create(a.tenant.id, a.agente.id, "services-a", "alquiler")).id;
    propertyB = (await create(b.tenant.id, b.agente.id, "services-b", "alquiler")).id;
    saleA = (await create(a.tenant.id, a.agente.id, "services-sale", "venta")).id;
    adminA = request.agent(app);
    adminB = request.agent(app);
    agentA = request.agent(app);
    csrfA = (await adminA.post("/v1/auth/login").send({ email: a.admin.email, password: TEST_PASSWORD })).body.csrf_token;
    await adminB.post("/v1/auth/login").send({ email: b.admin.email, password: TEST_PASSWORD });
    await agentA.post("/v1/auth/login").send({ email: a.agente.email, password: TEST_PASSWORD });
  });

  it("registra, lista y desactiva sin borrar el historial", async () => {
    const url = `/v1/rental-properties/${propertyA}/services`;
    const created = await adminA.post(url).set("x-csrf-token", csrfA).send(input);
    expect(created.status).toBe(201);
    expect(created.body.account).toMatchObject({ tenantId: a.tenant.id, accountNumber: "001234", active: true });
    expect((await adminA.get(url)).body.data).toHaveLength(1);
    const id = created.body.account.id;
    const deactivated = await adminA.post(`${url}/${id}/deactivate`).set("x-csrf-token", csrfA);
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.account.active).toBe(false);
    expect(deactivated.body.account.deactivatedAt).toBeTruthy();
    expect((await adminA.get(url)).body.data).toHaveLength(1);
    expect((await adminA.post(`${url}/${id}/deactivate`).set("x-csrf-token", csrfA)).status).toBe(404);
  });

  it("valida propiedad y número de cuenta o medidor", async () => {
    const create = (propertyId: string, body: object) => adminA.post(`/v1/rental-properties/${propertyId}/services`)
      .set("x-csrf-token", csrfA).send(body);
    expect((await create(propertyA, { type: "agua", provider: "SAT" })).status).toBe(400);
    expect((await create(saleA, input)).status).toBe(400);
    expect((await create(propertyB, input)).status).toBe(404);
  });

  it("aísla tenants y restringe acceso a administradores", async () => {
    expect((await adminB.get(`/v1/rental-properties/${propertyA}/services`)).status).toBe(404);
    expect((await agentA.get(`/v1/rental-properties/${propertyA}/services`)).status).toBe(403);
    expect((await request(app).get(`/v1/rental-properties/${propertyA}/services`)).status).toBe(401);
    expect(await runWithContext({ tenantId: b.tenant.id, userId: b.admin.id, rol: "admin" },
      (tx) => tx.rentalServiceAccount.findMany())).toHaveLength(0);
    await expect(adminDb().rentalServiceAccount.create({ data: {
      tenantId: a.tenant.id, propertyId: propertyB, createdById: a.admin.id,
      type: "gas", provider: "Gasnor", accountNumber: "x"
    } })).rejects.toThrow();
  });
});
