import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  DB_AVAILABLE,
  seedSuperAdmin,
  seedTenantWithUsers,
  TEST_PASSWORD,
  truncateAll
} from "./helpers.js";

async function loginAgent(app: ReturnType<typeof buildApp>, email: string, password = TEST_PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post("/v1/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  return { agent, csrf: res.body.csrf_token as string, cookies: res.get("set-cookie")! };
}

describe.runIf(DB_AVAILABLE)("Usuarios por API", () => {
  const app = buildApp();
  let A: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let B: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let superAdmin: Awaited<ReturnType<typeof seedSuperAdmin>>;

  beforeAll(async () => {
    await truncateAll();
    A = await seedTenantWithUsers("users-a");
    B = await seedTenantWithUsers("users-b");
    superAdmin = await seedSuperAdmin();
  });

  it("admin cambia la contrasena de un agente de su tenant y revoca su refresh", async () => {
    const victim = await loginAgent(app, A.agente.email);
    const admin = await loginAgent(app, A.admin.email);
    const newPassword = "admin-cambio-123";

    const res = await admin.agent
      .post(`/v1/users/${A.agente.id}/password`)
      .set("x-csrf-token", admin.csrf)
      .send({ new_password: newPassword, notify: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const oldLogin = await request(app)
      .post("/v1/auth/login")
      .send({ email: A.agente.email, password: TEST_PASSWORD });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post("/v1/auth/login")
      .send({ email: A.agente.email, password: newPassword });
    expect(newLogin.status).toBe(200);

    const refresh = await request(app).post("/v1/auth/refresh").set("Cookie", victim.cookies);
    expect(refresh.status).toBe(401);
  });

  it("admin no cambia contrasenas de otro tenant", async () => {
    const victim = await loginAgent(app, B.agente.email);
    const adminA = await loginAgent(app, A.admin.email);

    const res = await adminA.agent
      .post(`/v1/users/${B.agente.id}/password`)
      .set("x-csrf-token", adminA.csrf)
      .send({ new_password: "no-debe-aplicar-123", notify: false });
    expect(res.status).toBe(404);

    const oldLogin = await request(app)
      .post("/v1/auth/login")
      .send({ email: B.agente.email, password: TEST_PASSWORD });
    expect(oldLogin.status).toBe(200);

    const refresh = await request(app).post("/v1/auth/refresh").set("Cookie", victim.cookies);
    expect(refresh.status).toBe(200);
  });

  it("agente no puede usar el endpoint administrado", async () => {
    const agente = await loginAgent(app, A.agente.email, "admin-cambio-123");

    const res = await agente.agent
      .post(`/v1/users/${A.admin.id}/password`)
      .set("x-csrf-token", agente.csrf)
      .send({ new_password: "agente-no-puede-123", notify: false });
    expect(res.status).toBe(403);
  });

  it("super_admin cambia la contrasena de un usuario de tenant", async () => {
    const superSession = await loginAgent(app, superAdmin.email);
    const newPassword = "super-cambio-123";

    const res = await superSession.agent
      .post(`/v1/users/${B.agente.id}/password`)
      .set("x-csrf-token", superSession.csrf)
      .send({ new_password: newPassword, notify: false });
    expect(res.status).toBe(200);

    const oldLogin = await request(app)
      .post("/v1/auth/login")
      .send({ email: B.agente.email, password: TEST_PASSWORD });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post("/v1/auth/login")
      .send({ email: B.agente.email, password: newPassword });
    expect(newLogin.status).toBe(200);
  });

  it("no permite cambiar la contrasena de super_admins por API", async () => {
    const superSession = await loginAgent(app, superAdmin.email);

    const res = await superSession.agent
      .post(`/v1/users/${superAdmin.id}/password`)
      .set("x-csrf-token", superSession.csrf)
      .send({ new_password: "super-bloqueado-123", notify: false });
    expect(res.status).toBe(403);
  });

  it("valida largo minimo de la nueva contrasena", async () => {
    const admin = await loginAgent(app, A.admin.email);

    const res = await admin.agent
      .post(`/v1/users/${A.admin.id}/password`)
      .set("x-csrf-token", admin.csrf)
      .send({ new_password: "corta", notify: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
