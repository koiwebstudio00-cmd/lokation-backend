import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Configuración del agente por inmobiliaria", () => {
  const app = buildApp();
  let adminA: ReturnType<typeof request.agent>;
  let adminB: ReturnType<typeof request.agent>;
  let csrfA = "";
  let csrfB = "";
  let keyA = "";
  let keyB = "";
  let keyExport = "";

  beforeAll(async () => {
    await truncateAll();
    const A = await seedTenantWithUsers("agent-config-a");
    const B = await seedTenantWithUsers("agent-config-b");
    async function login(email: string) {
      const agent = request.agent(app);
      const res = await agent.post("/v1/auth/login").send({ email, password: TEST_PASSWORD });
      expect(res.status).toBe(200);
      return { agent, csrf: res.body.csrf_token as string };
    }
    ({ agent: adminA, csrf: csrfA } = await login(A.admin.email));
    ({ agent: adminB, csrf: csrfB } = await login(B.admin.email));
    async function makeKey(agent: ReturnType<typeof request.agent>, csrf: string, scopes: string[]) {
      const res = await agent.post("/v1/integrations/api-keys")
        .set("x-csrf-token", csrf).send({ nombre: "Prueba", scopes });
      expect(res.status).toBe(201);
      return res.body.key as string;
    }
    keyA = await makeKey(adminA, csrfA, ["agent:read"]);
    keyB = await makeKey(adminB, csrfB, ["agent:read"]);
    keyExport = await makeKey(adminA, csrfA, ["export:read"]);
  });

  it("guarda instrucciones de A sin exponerlas a B", async () => {
    const config = { model: "openai/modelo-ejemplo", instructions: "Atendé consultas inmobiliarias de la empresa A." };
    const saved = await adminA.patch("/v1/tenants/current")
      .set("x-csrf-token", csrfA).send({ agent_config: config });
    expect(saved.status).toBe(200);
    expect(saved.body.tenant.agentConfig).toEqual(config);
    const own = await request(app).get("/v1/agent/config").set("x-api-key", keyA);
    const other = await request(app).get("/v1/agent/config").set("x-api-key", keyB);
    expect(own.status).toBe(200);
    expect(own.body.config).toEqual(config);
    expect(other.status).toBe(200);
    expect(other.body.config).toBeNull();
  });

  it("rechaza una key de exportación y configuración incompleta", async () => {
    const denied = await request(app).get("/v1/agent/config").set("x-api-key", keyExport);
    expect(denied.status).toBe(403);
    const bad = await adminB.patch("/v1/tenants/current")
      .set("x-csrf-token", csrfB).send({ agent_config: { model: "x", instructions: "corto" } });
    expect(bad.status).toBe(400);
  });
});
