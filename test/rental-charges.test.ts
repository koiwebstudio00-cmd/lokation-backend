import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Cargos y cobros manuales", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let contractA: string;
  let contractB: string;
  let chargeId: string;
  let paymentId: string;
  let adminA: ReturnType<typeof request.agent>;
  let adminB: ReturnType<typeof request.agent>;
  let agentA: ReturnType<typeof request.agent>;
  let csrfA: string;

  beforeAll(async () => {
    await truncateAll();
    a = await seedTenantWithUsers("charges-a");
    b = await seedTenantWithUsers("charges-b");
    const db = adminDb();
    const create = async (tenantId: string, adminId: string, agentId: string, slug: string) => {
      const property = await db.property.create({ data: { tenantId, userId: agentId, titulo: slug, slug,
        operacion: "alquiler", tipo: "departamento", precio: 400000, moneda: "ARS" } });
      const owner = await db.rentalPerson.create({ data: { tenantId, createdById: adminId, nombre: `Dueño ${slug}`, roles: ["propietario"] } });
      const renter = await db.rentalPerson.create({ data: { tenantId, createdById: adminId, nombre: `Inquilino ${slug}`, roles: ["inquilino"] } });
      const contract = await db.rentalContract.create({ data: { tenantId, propertyId: property.id,
        ownerPersonId: owner.id, tenantPersonId: renter.id, createdById: adminId,
        startDate: new Date("2026-01-15"), endDate: new Date("2027-12-31"),
        monthlyRent: "400000.25", currency: "ARS", dueDay: 10, status: "vigente" } });
      return contract.id;
    };
    contractA = await create(a.tenant.id, a.admin.id, a.agente.id, "charges-a");
    contractB = await create(b.tenant.id, b.admin.id, b.agente.id, "charges-b");
    adminA = request.agent(app);
    adminB = request.agent(app);
    agentA = request.agent(app);
    csrfA = (await adminA.post("/v1/auth/login").send({ email: a.admin.email, password: TEST_PASSWORD })).body.csrf_token;
    await adminB.post("/v1/auth/login").send({ email: b.admin.email, password: TEST_PASSWORD });
    await agentA.post("/v1/auth/login").send({ email: a.agente.email, password: TEST_PASSWORD });
  });

  it("genera un cargo mensual idempotente y respeta la vigencia", async () => {
    const path = `/v1/rental-contracts/${contractA}/charges`;
    const first = await adminA.post(path).set("x-csrf-token", csrfA).send({ period: "2026-01" });
    expect(first.status).toBe(201);
    chargeId = first.body.charge.id;
    expect(first.body.charge.dueDate.slice(0, 10)).toBe("2026-01-15");
    expect(first.body.charge.amount).toBe("400000.25");
    const retry = await adminA.post(path).set("x-csrf-token", csrfA).send({ period: "2026-01" });
    expect(retry.status).toBe(200);
    expect(retry.body.charge.id).toBe(chargeId);
    expect((await adminA.get(path)).body.meta.total).toBe(1);
    expect((await adminA.post(path).set("x-csrf-token", csrfA).send({ period: "2025-12" })).status).toBe(400);
  });

  it("registra parciales, evita exceso, permite reverso y conserva rastro", async () => {
    const path = `/v1/rental-charges/${chargeId}/payments`;
    const first = { idempotency_key: randomUUID(), amount: "150000.25", paid_at: "2026-01-20",
      method: "transferencia", reference: "TX-001" };
    const created = await adminA.post(path).set("x-csrf-token", csrfA).send(first);
    expect(created.status).toBe(201);
    paymentId = created.body.payment.id;
    expect((await adminA.post(path).set("x-csrf-token", csrfA).send(first)).status).toBe(200);
    expect((await adminA.post(path).set("x-csrf-token", csrfA)
      .send({ ...first, amount: "100000" })).status).toBe(409);
    const second = await adminA.post(path).set("x-csrf-token", csrfA).send({ ...first,
      idempotency_key: randomUUID(), amount: "250000", reference: "TX-002" });
    expect(second.status).toBe(201);
    const detail = await adminA.get(`/v1/rental-contracts/${contractA}/charges`);
    expect(detail.body.data[0]).toMatchObject({ paid: "400000.25", balance: "0.00" });
    expect((await adminA.post(path).set("x-csrf-token", csrfA).send({ ...first,
      idempotency_key: randomUUID(), amount: "1" })).status).toBe(409);
    const voided = await adminA.post(`/v1/rental-payments/${paymentId}/void`).set("x-csrf-token", csrfA)
      .send({ reason: "Comprobante duplicado" });
    expect(voided.status).toBe(200);
    expect(voided.body.payment.voidedAt).toBeTruthy();
    expect((await adminA.get(`/v1/rental-contracts/${contractA}/charges`)).body.data[0].balance).toBe("150000.25");
    expect((await adminA.post(`/v1/rental-payments/${paymentId}/void`).set("x-csrf-token", csrfA)
      .send({ reason: "Otra vez" })).status).toBe(409);
    const concurrent = await Promise.all([1, 2].map((n) => adminA.post(path).set("x-csrf-token", csrfA)
      .send({ idempotency_key: randomUUID(), amount: "100000", paid_at: "2026-01-22",
        method: "transferencia", reference: `CONCURRENT-${n}` })));
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 409]);
  });

  it("aísla tenants, roles y referencias cruzadas", async () => {
    expect((await adminB.get(`/v1/rental-contracts/${contractA}/charges`)).status).toBe(404);
    expect((await adminA.get(`/v1/rental-contracts/${contractB}/charges`)).status).toBe(404);
    expect((await agentA.get(`/v1/rental-contracts/${contractA}/charges`)).status).toBe(403);
    expect((await request(app).get(`/v1/rental-contracts/${contractA}/charges`)).status).toBe(401);
    expect(await runWithContext({ tenantId: b.tenant.id, userId: b.admin.id, rol: "admin" },
      (tx) => tx.rentalCharge.findMany())).toHaveLength(0);
    await expect(adminDb().rentalPayment.create({ data: {
      tenantId: b.tenant.id, chargeId, createdById: b.admin.id, idempotencyKey: randomUUID(),
      amount: "1", paidAt: new Date("2026-01-20"), method: "efectivo"
    } })).rejects.toThrow();
  });

  it("resume saldos y contratos de la inmobiliaria sin cruzar datos", async () => {
    const own = await adminA.get("/v1/rental-overview");
    const other = await adminB.get("/v1/rental-overview");
    expect(own.status).toBe(200);
    expect(own.body.contracts.vigente).toBe(1);
    expect(own.body.balances).toEqual([{ currency: "ARS", balance: "50000.25", overdue: "50000.25" }]);
    expect(other.body.contracts.vigente).toBe(1);
    expect(other.body.balances).toEqual([]);
    expect((await agentA.get("/v1/rental-overview")).status).toBe(403);
  });
});
