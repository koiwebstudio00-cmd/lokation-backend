import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Consumo de IA para fichas por inmobiliaria", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let adminA: ReturnType<typeof request.agent>;
  let adminB: ReturnType<typeof request.agent>;
  let agenteA: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await truncateAll();
    a = await seedTenantWithUsers("copy-usage-a");
    b = await seedTenantWithUsers("copy-usage-b");
    await adminDb().propertyCopyUsage.createMany({ data: [
      { tenantId: a.tenant.id, userId: a.agente.id, model: "gpt-5-mini", inputTokens: 100, outputTokens: 30 },
      { tenantId: b.tenant.id, userId: b.agente.id, model: "gpt-5-mini", inputTokens: 900, outputTokens: 200 }
    ] });
    adminA = request.agent(app);
    adminB = request.agent(app);
    agenteA = request.agent(app);
    await adminA.post("/v1/auth/login").send({ email: a.admin.email, password: TEST_PASSWORD });
    await adminB.post("/v1/auth/login").send({ email: b.admin.email, password: TEST_PASSWORD });
    await agenteA.post("/v1/auth/login").send({ email: a.agente.email, password: TEST_PASSWORD });
  });

  it("muestra sólo el consumo del tenant del administrador", async () => {
    const [aResponse, bResponse] = await Promise.all([
      adminA.get("/v1/analytics/property-copy-usage"),
      adminB.get("/v1/analytics/property-copy-usage")
    ]);
    expect(aResponse.status).toBe(200);
    expect(aResponse.body).toMatchObject({ generations: 1, input_tokens: 100, output_tokens: 30 });
    expect(bResponse.status).toBe(200);
    expect(bResponse.body).toMatchObject({ generations: 1, input_tokens: 900, output_tokens: 200 });
  });

  it("niega la vista al agente y RLS impide leer o insertar consumo ajeno", async () => {
    expect((await agenteA.get("/v1/analytics/property-copy-usage")).status).toBe(403);
    const rows = await runWithContext({ tenantId: a.tenant.id, userId: a.admin.id, rol: "admin" },
      (tx) => tx.propertyCopyUsage.findMany());
    expect(rows).toHaveLength(1);
    await expect(runWithContext({ tenantId: a.tenant.id, userId: a.admin.id, rol: "admin" },
      (tx) => tx.propertyCopyUsage.create({ data: {
        tenantId: b.tenant.id, userId: a.admin.id, model: "gpt-5-mini"
      } }))).rejects.toThrow();
  });
});
