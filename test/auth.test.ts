import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { randomToken, sha256, addDays, addHours } from "../src/lib/tokens.js";
import {
  adminDb,
  DB_AVAILABLE,
  seedSuperAdmin,
  seedTenantWithUsers,
  TEST_PASSWORD,
  truncateAll
} from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Auth por API", () => {
  const app = buildApp();
  let agenteEmail = "";
  let agenteId = "";

  beforeAll(async () => {
    await truncateAll();
    const a = await seedTenantWithUsers("alfa");
    await seedTenantWithUsers("beta");
    await seedSuperAdmin();
    agenteEmail = a.agente.email;
    agenteId = a.agente.id;
  });

  it("login OK setea cookies y devuelve el usuario", async () => {
    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: agenteEmail, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(agenteEmail);
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.csrf_token).toBeTruthy();
    const cookies = res.get("set-cookie")!.join(";");
    expect(cookies).toContain("access_token=");
    expect(cookies).toContain("refresh_token=");
    expect(cookies).toContain("HttpOnly");
  });

  it("login con password incorrecta devuelve 401 genérico", async () => {
    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: agenteEmail, password: "incorrecta1" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("GET /auth/me con sesión y 401 sin sesión", async () => {
    const agent = request.agent(app);
    await agent.post("/v1/auth/login").send({ email: agenteEmail, password: TEST_PASSWORD });
    const me = await agent.get("/v1/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.tenant.slug).toBe("alfa");

    const anon = await request(app).get("/v1/auth/me");
    expect(anon.status).toBe(401);
  });

  it("logout exige CSRF y cierra la sesión", async () => {
    const agent = request.agent(app);
    const login = await agent
      .post("/v1/auth/login")
      .send({ email: agenteEmail, password: TEST_PASSWORD });
    const csrf = login.body.csrf_token as string;

    const sinCsrf = await agent.post("/v1/auth/logout").send({});
    expect(sinCsrf.status).toBe(403);

    const conCsrf = await agent.post("/v1/auth/logout").set("x-csrf-token", csrf).send({});
    expect(conCsrf.status).toBe(200);

    const me = await agent.get("/v1/auth/me");
    expect(me.status).toBe(401);
  });

  it("refresh rota el token: el anterior queda inválido", async () => {
    const login = await request(app)
      .post("/v1/auth/login")
      .send({ email: agenteEmail, password: TEST_PASSWORD });
    const originalCookies = login.get("set-cookie")!;

    const r1 = await request(app).post("/v1/auth/refresh").set("Cookie", originalCookies);
    expect(r1.status).toBe(200);

    // Reusar el refresh original (ya rotado) debe fallar.
    const r2 = await request(app).post("/v1/auth/refresh").set("Cookie", originalCookies);
    expect(r2.status).toBe(401);
  });

  it("suspender un tenant corta sesión activa, refresh y login sin afectar a otro", async () => {
    const tenant = await adminDb().tenant.findUniqueOrThrow({ where: { slug: "alfa" } });
    const sesionA = request.agent(app);
    const sesionB = request.agent(app);
    const operador = request.agent(app);
    await sesionA.post("/v1/auth/login").send({ email: agenteEmail, password: TEST_PASSWORD }).expect(200);
    await sesionB.post("/v1/auth/login").send({ email: "admin@beta.test", password: TEST_PASSWORD }).expect(200);
    const superLogin = await operador.post("/v1/auth/login")
      .send({ email: "super@test.test", password: TEST_PASSWORD }).expect(200);

    try {
      await operador.patch(`/v1/tenants/${tenant.id}`)
        .set("x-csrf-token", superLogin.body.csrf_token)
        .send({ estado: "suspendido" }).expect(200);

      await sesionA.get("/v1/auth/me").expect(403);
      await sesionA.post("/v1/auth/refresh").expect(401);
      await request(app).post("/v1/auth/login")
        .send({ email: agenteEmail, password: TEST_PASSWORD }).expect(403);
      await sesionB.get("/v1/auth/me").expect(200);
      await operador.get("/v1/auth/me").expect(200);
    } finally {
      await operador.patch(`/v1/tenants/${tenant.id}`)
        .set("x-csrf-token", superLogin.body.csrf_token)
        .send({ estado: "activo" }).expect(200);
    }

    // La cookie refresh anterior se revocó en la misma transacción de suspensión.
    await sesionA.post("/v1/auth/refresh").expect(401);
    // El JWT anterior sigue inválido incluso después de reactivar el tenant.
    await sesionA.get("/v1/auth/me").expect(401);
    await request(app).post("/v1/auth/login")
      .send({ email: agenteEmail, password: TEST_PASSWORD }).expect(200);
  });

  it("reset de contraseña: token válido cambia la password y revoca sesiones", async () => {
    const token = randomToken();
    await adminDb().passwordReset.create({
      data: { userId: agenteId, tokenHash: sha256(token), expiresAt: addHours(1) }
    });

    const res = await request(app)
      .post("/v1/auth/reset-password")
      .send({ token, password: "nueva-clave-123" });
    expect(res.status).toBe(200);

    const oldLogin = await request(app)
      .post("/v1/auth/login")
      .send({ email: agenteEmail, password: TEST_PASSWORD });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post("/v1/auth/login")
      .send({ email: agenteEmail, password: "nueva-clave-123" });
    expect(newLogin.status).toBe(200);

    // Restaurar para el resto de la suite.
    await request(app)
      .post("/v1/auth/reset-password")
      .send({ token, password: TEST_PASSWORD })
      .expect(401); // token ya usado

    const token2 = randomToken();
    await adminDb().passwordReset.create({
      data: { userId: agenteId, tokenHash: sha256(token2), expiresAt: addHours(1) }
    });
    await request(app)
      .post("/v1/auth/reset-password")
      .send({ token: token2, password: TEST_PASSWORD })
      .expect(200);
  });

  it("aceptar invitación crea el usuario en el tenant con el rol invitado", async () => {
    const tenant = await adminDb().tenant.findUnique({ where: { slug: "alfa" } });
    const admin = await adminDb().user.findFirst({
      where: { tenantId: tenant!.id, rol: "admin" }
    });
    const token = randomToken();
    await adminDb().invitation.create({
      data: {
        tenantId: tenant!.id,
        invitedBy: admin!.id,
        email: "nuevo@alfa.test",
        rol: "agente",
        tokenHash: sha256(token),
        expiresAt: addDays(7)
      }
    });

    const res = await request(app)
      .post("/v1/auth/accept-invitation")
      .send({ token, nombre: "Nuevo Agente", password: "clave-segura-1" });
    expect(res.status).toBe(201);
    expect(res.body.user.rol).toBe("agente");
    expect(res.body.user.tenant.slug).toBe("alfa");

    // Reuso de la invitación → 401
    const reuse = await request(app)
      .post("/v1/auth/accept-invitation")
      .send({ token, nombre: "Otro", password: "clave-segura-1" });
    expect(reuse.status).toBe(401);
  });
});
