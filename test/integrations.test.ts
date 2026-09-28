import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: ReturnType<typeof buildApp>, email: string) {
  const agent = request.agent(app);
  const res = await agent.post("/v1/auth/login").send({ email, password: TEST_PASSWORD });
  return { agent, csrf: res.body.csrf_token as string };
}

describe.runIf(DB_AVAILABLE)("Integraciones (API keys con scopes)", () => {
  const app = buildApp();
  let A: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let adminA: { agent: Agent; csrf: string };
  let agenteA: { agent: Agent; csrf: string };

  beforeAll(async () => {
    await truncateAll();
    A = await seedTenantWithUsers("inta");
    adminA = await loginAgent(app, A.admin.email);
    agenteA = await loginAgent(app, A.agente.email);
  });

  it("por defecto la key nace con scope export:read (compatibilidad)", async () => {
    const res = await adminA.agent
      .post("/v1/integrations/api-keys")
      .set("x-csrf-token", adminA.csrf)
      .send({ nombre: "Sitio público" });
    expect(res.status).toBe(201);
    expect(res.body.api_key.scopes).toEqual(["export:read"]);
    expect(res.body.key.startsWith("ilk_")).toBe(true);

    // Y sirve para lo que tiene que servir.
    const uso = await request(app).get("/v1/export/properties").set("x-api-key", res.body.key);
    expect(uso.status).toBe(200);
  });

  it("se puede crear una key del agente con sus dos scopes", async () => {
    const res = await adminA.agent
      .post("/v1/integrations/api-keys")
      .set("x-csrf-token", adminA.csrf)
      .send({ nombre: "Agente n8n", scopes: ["agent:read", "agent:write"] });
    expect(res.status).toBe(201);
    expect(res.body.api_key.scopes).toEqual(["agent:read", "agent:write"]);

    // Pero NO le abre la puerta de export: el scope es el que manda.
    const cruzado = await request(app)
      .get("/v1/export/properties")
      .set("x-api-key", res.body.key);
    expect(cruzado.status).toBe(403);
    expect(cruzado.body.error.code).toBe("FORBIDDEN");
    expect(cruzado.body.error.message).toContain("export:read");
  });

  it("una key válida sin scope da 403, una key inexistente da 401", async () => {
    const inexistente = await request(app)
      .get("/v1/export/properties")
      .set("x-api-key", "ilk_deadbeef00000000000000000000000000000000000000000");
    expect(inexistente.status).toBe(401);
  });

  it("rechaza scopes inventados", async () => {
    const res = await adminA.agent
      .post("/v1/integrations/api-keys")
      .set("x-csrf-token", adminA.csrf)
      .send({ nombre: "Trucha", scopes: ["agent:admin"] });
    expect(res.status).toBe(400);
  });

  it("rechaza la lista de scopes vacía", async () => {
    const res = await adminA.agent
      .post("/v1/integrations/api-keys")
      .set("x-csrf-token", adminA.csrf)
      .send({ nombre: "Sin permisos", scopes: [] });
    expect(res.status).toBe(400);
  });

  it("el listado muestra los scopes y nunca la key en claro", async () => {
    const list = await adminA.agent.get("/v1/integrations/api-keys");
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(2);
    for (const k of list.body.data) {
      expect(Array.isArray(k.scopes)).toBe(true);
      expect(k.prefix).toHaveLength(12);
    }
    expect(JSON.stringify(list.body)).not.toMatch(/ilk_[0-9a-f]{48}/);
  });

  it("el vendedor no gestiona integraciones", async () => {
    const res = await agenteA.agent
      .post("/v1/integrations/api-keys")
      .set("x-csrf-token", agenteA.csrf)
      .send({ nombre: "no debería" });
    expect(res.status).toBe(403);

    const list = await agenteA.agent.get("/v1/integrations/api-keys");
    expect(list.status).toBe(403);
  });

  it("el alias /v1/api-keys sigue funcionando para el panel actual", async () => {
    const res = await adminA.agent
      .post("/v1/api-keys")
      .set("x-csrf-token", adminA.csrf)
      .send({ nombre: "Por el alias" });
    expect(res.status).toBe(201);
    expect(res.body.api_key.scopes).toEqual(["export:read"]);

    const list = await adminA.agent.get("/v1/api-keys");
    expect(list.status).toBe(200);
    expect(
      list.body.data.some((k: { nombre: string }) => k.nombre === "Por el alias")
    ).toBe(true);

    const del = await adminA.agent
      .delete(`/v1/api-keys/${res.body.api_key.id}`)
      .set("x-csrf-token", adminA.csrf);
    expect(del.status).toBe(204);
  });

  it("el catálogo de scopes alimenta el formulario del panel", async () => {
    const res = await adminA.agent.get("/v1/integrations/scopes");
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { scope: string }) => s.scope)).toEqual([
      "export:read",
      "agent:read",
      "agent:write"
    ]);
  });
});
