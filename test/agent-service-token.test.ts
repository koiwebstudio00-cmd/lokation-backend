import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { signAgentServiceToken } from "../src/lib/agent-service-token.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Credencial interna del servicio de IA", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: Awaited<ReturnType<typeof seedTenantWithUsers>>;

  beforeAll(async () => {
    await truncateAll();
    a = await seedTenantWithUsers("agent-token-a");
    b = await seedTenantWithUsers("agent-token-b");
    await adminDb().property.create({ data: {
      tenantId: b.tenant.id, userId: b.agente.id, titulo: "Solo B",
      slug: "solo-b-token", operacion: "venta", tipo: "casa", precio: 100,
      moneda: "USD"
    } });
  });

  it("acota los endpoints agent:* al tenant firmado", async () => {
    const token = signAgentServiceToken(a.tenant.id);
    const own = await request(app).get("/v1/agent/properties").set("x-agent-service-token", token);
    expect(own.status).toBe(200);
    expect(own.body.meta.total).toBe(0);
    const exportDenied = await request(app).get("/v1/export/properties").set("x-agent-service-token", token);
    expect(exportDenied.status).toBe(403);
  });

  it("rechaza firmas alteradas, expiradas y tenants suspendidos", async () => {
    const valid = signAgentServiceToken(a.tenant.id);
    expect((await request(app).get("/v1/agent/config")
      .set("x-agent-service-token", `${valid.slice(0, -1)}x`)).status).toBe(401);
    const expired = signAgentServiceToken(a.tenant.id, Date.now() - 600_000);
    expect((await request(app).get("/v1/agent/config")
      .set("x-agent-service-token", expired)).status).toBe(401);
    await adminDb().tenant.update({ where: { id: a.tenant.id }, data: { estado: "suspendido" } });
    expect((await request(app).get("/v1/agent/config")
      .set("x-agent-service-token", valid)).status).toBe(403);
  });
});
