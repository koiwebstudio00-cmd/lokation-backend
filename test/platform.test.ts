import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { encodeCBOR } from "@levischuck/tiny-cbor";
import * as OTPAuth from "otpauth";
import { buildApp } from "../src/app.js";
import { adminDb, DB_AVAILABLE, seedSuperAdmin, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";
import { runWithContext } from "../src/lib/prisma.js";
const app = buildApp();
const password = "New-secure-password-123!";
async function login(email: string, pass = TEST_PASSWORD, otp?: string) {
  const agent = request.agent(app); const res = await agent.post("/v1/auth/login").send({ email, password: pass, otp });
  return { agent, csrf: res.body.csrf_token as string, res };
}
describe.runIf(DB_AVAILABLE)("Plataforma: permisos, operadores y seguridad", () => {
  let owner: Awaited<ReturnType<typeof seedSuperAdmin>>;
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let session: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => { await truncateAll(); owner = await seedSuperAdmin(); a = await seedTenantWithUsers("platform-a"); b = await seedTenantWithUsers("platform-b"); session = await login(owner.email); });
  it("restringe rutas y tablas de seguridad a operadores/auth; dos tenants aislados", async () => {
    for (const tenant of [a, b]) {
      const user = await login(tenant.admin.email);
      for (const path of ["stats", "operators", "security", `tenants/${a.tenant.id}`]) expect((await user.agent.get(`/v1/platform/${path}`)).status).toBe(403);
      expect((await user.agent.post("/v1/platform/operators").set("x-csrf-token", user.csrf).send({ nombre: "Intruso", email: "intruso@test.test", password })).status).toBe(403);
      const data = await runWithContext({ rol: "admin", tenantId: tenant.tenant.id, userId: tenant.admin.id }, async tx => ({ security: await tx.userSecurity.findMany(), keys: await tx.passkey.findMany(), audit: await tx.platformAudit.findMany() }));
      expect(data).toEqual({ security: [], keys: [], audit: [] });
    }
    expect((await request(app).get("/v1/platform/stats")).status).toBe(401);
    expect((await session.agent.post("/v1/platform/operators").send({ nombre: "Sin csrf", email: "csrf@test.test", password })).status).toBe(403);
  });
  it("crea, edita, suspende y elimina operadores revocando sesiones sin exponer credenciales", async () => {
    const created = await session.agent.post("/v1/platform/operators").set("x-csrf-token", session.csrf).send({ nombre: "Operador", email: "operador@test.test", password });
    expect(created.status).toBe(201); expect(JSON.stringify(created.body)).not.toMatch(/passwordHash|secret/);
    const id = created.body.user.id; const operator = await login("operador@test.test", password);
    expect(operator.res.status).toBe(200);
    expect((await session.agent.patch(`/v1/platform/operators/${id}`).set("x-csrf-token", session.csrf).send({ nombre: "Operador editado", estado: "inactivo" })).status).toBe(200);
    expect((await operator.agent.get("/v1/platform/stats")).status).toBe(401);
    await session.agent.patch(`/v1/platform/operators/${id}`).set("x-csrf-token", session.csrf).send({ estado: "activo" });
    expect((await operator.agent.get("/v1/platform/stats")).status).toBe(401);
    expect((await session.agent.delete(`/v1/platform/operators/${id}`).set("x-csrf-token", session.csrf)).status).toBe(200);
    expect((await login("operador@test.test", password)).res.status).toBe(401);
    expect((await session.agent.get("/v1/platform/operators")).body.data).not.toContainEqual(expect.objectContaining({ id }));
    expect((await session.agent.delete(`/v1/platform/operators/${owner.id}`).set("x-csrf-token", session.csrf)).status).toBe(409);
    expect((await session.agent.patch(`/v1/platform/operators/${a.admin.id}`).set("x-csrf-token", session.csrf).send({ estado: "inactivo" })).status).toBe(404);
  });
  it("sirve estadísticas y detalles reales sin mensajes privados", async () => {
    const stats = await session.agent.get("/v1/platform/stats"); expect(stats.status).toBe(200); expect(stats.body.totals.tenants).toBe(2); expect(stats.body.totals.users).toBe(4);
    const detail = await session.agent.get(`/v1/platform/tenants/${a.tenant.id}`); expect(detail.status).toBe(200); expect(detail.body.tenant.users).toHaveLength(2);
    expect(JSON.stringify(detail.body)).not.toMatch(/passwordHash|tokenHash|recoveryHashes/);
  });
  it("2FA exige confirmación, bloquea contraseña sola y evita reuso; recovery de un solo uso", async () => {
    const setup = await session.agent.post("/v1/platform/security/2fa/setup").set("x-csrf-token", session.csrf).send({ password: TEST_PASSWORD }); expect(setup.status).toBe(200);
    const totp = new OTPAuth.TOTP({ secret: setup.body.secret });
    expect((await adminDb().userSecurity.findUniqueOrThrow({ where: { userId: owner.id } })).pendingSecret).not.toContain(setup.body.secret);
    expect((await session.agent.post("/v1/platform/security/2fa/enable").set("x-csrf-token", session.csrf).send({ code: "invalid" })).status).toBe(400);
    const enabled = await session.agent.post("/v1/platform/security/2fa/enable").set("x-csrf-token", session.csrf).send({ code: totp.generate() }); expect(enabled.status).toBe(200); expect(enabled.body.recoveryCodes).toHaveLength(10);
    const hidden = await runWithContext({ rol: "admin", tenantId: a.tenant.id, userId: a.admin.id }, tx => tx.userSecurity.findMany());
    expect(hidden).toEqual([]);
    expect((await session.agent.get("/v1/platform/stats")).status).toBe(401);
    expect((await login(owner.email)).res.status).toBe(401);
    expect((await login(owner.email, TEST_PASSWORD, totp.generate())).res.status).toBe(401);
    const [first, second] = await Promise.all([login(owner.email, TEST_PASSWORD, enabled.body.recoveryCodes[0]), login(owner.email, TEST_PASSWORD, enabled.body.recoveryCodes[0])]);
    expect([first.res.status, second.res.status].sort()).toEqual([200, 401]);
    session = first.res.status === 200 ? first : second;
    await session.agent.post("/v1/platform/security/password").set("x-csrf-token", session.csrf).send({ newPassword: password }).expect(401);
    const changed = await session.agent.post("/v1/platform/security/password").set("x-csrf-token", session.csrf).send({ newPassword: password, otp: enabled.body.recoveryCodes[1] }); expect(changed.status).toBe(200);
    expect((await session.agent.get("/v1/platform/security")).status).toBe(401);
    session = await login(owner.email, password, enabled.body.recoveryCodes[2]); expect(session.res.status).toBe(200);
    expect((await session.agent.post("/v1/users/me/password").set("x-csrf-token", session.csrf).send({ current_password: password, new_password: "bypass-123456" })).status).toBe(403);
    expect((await session.agent.post("/v1/platform/security/2fa/disable").set("x-csrf-token", session.csrf).send({ password, otp: enabled.body.recoveryCodes[3] })).status).toBe(200);
    session = await login(owner.email, password); expect(session.res.status).toBe(200);
  });
  it("registra y autentica una passkey con firma real; rechaza origen incorrecto y replay", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    const cose = encodeCBOR(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
    const credentialId = randomBytes(32), id = credentialId.toString("base64url");
    const options = await session.agent.post("/v1/platform/security/passkeys/options").set("x-csrf-token", session.csrf).send({ password }); expect(options.status).toBe(200);
    const rpHash = createHash("sha256").update("localhost").digest();
    const length = Buffer.alloc(2); length.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, credentialId, cose]);
    const client = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.body.options.challenge, origin: "http://localhost:3003" })).toString("base64url");
    const attestation = encodeCBOR(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as Parameters<typeof encodeCBOR>[0]);
    const response = { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: client, attestationObject: Buffer.from(attestation).toString("base64url"), transports: ["internal"] } };
    const registered = await session.agent.post("/v1/platform/security/passkeys/verify").set("x-csrf-token", session.csrf).send({ challengeId: options.body.challengeId, response, nombre: "Test passkey" }); expect(registered.status).toBe(200);
    async function assertion(origin: string, flags = 0x05) {
      const options = await request(app).post("/v1/auth/passkey/options").send({});
      const client = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.body.options.challenge, origin }));
      const count = Buffer.alloc(4); count.writeUInt32BE(1);
      const authenticatorData = Buffer.concat([rpHash, Buffer.from([flags]), count]);
      const signature = sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(client).digest()]), privateKey);
      return { challengeId: options.body.challengeId, response: { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: client.toString("base64url"), authenticatorData: authenticatorData.toString("base64url"), signature: signature.toString("base64url"), userHandle: Buffer.from(owner.id).toString("base64url") } } };
    }
    expect((await request(app).post("/v1/auth/passkey/verify").send(await assertion("https://evil.test"))).status).toBe(401);
    expect((await request(app).post("/v1/auth/passkey/verify").send(await assertion("http://localhost:3003", 0x01))).status).toBe(401);
    const body = await assertion("http://localhost:3003"); const logged = await request(app).post("/v1/auth/passkey/verify").send(body); expect(logged.status).toBe(200); expect(logged.body.user.id).toBe(owner.id);
    expect((await request(app).post("/v1/auth/passkey/verify").send(body)).status).toBe(401);
    expect((await session.agent.post("/v1/platform/security/passkeys/remove").set("x-csrf-token", session.csrf).send({ id, password })).status).toBe(200);
    expect((await session.agent.get("/v1/platform/security")).status).toBe(401);
  });
  it("cambia la clave propia sin la anterior, exige sesión y CSRF y revoca sesiones", async () => {
    const path = "/v1/platform/security/password";
    const newPassword = "Updated-from-profile-456!";
    await request(app).post(path).send({ newPassword }).expect(401);
    for (const tenant of [a, b]) {
      const user = await login(tenant.admin.email);
      await user.agent.post(path).set("x-csrf-token", user.csrf).send({ newPassword }).expect(403);
    }
    const current = await login(owner.email, password);
    const otherSession = await login(owner.email, password);
    await current.agent.post(path).send({ newPassword }).expect(403);
    await current.agent.post(path).set("x-csrf-token", current.csrf).send({ newPassword: "short" }).expect(400);
    await current.agent.post(path).set("x-csrf-token", current.csrf).send({ newPassword, userId: a.admin.id }).expect(200);
    await current.agent.get("/v1/auth/me").expect(401);
    await otherSession.agent.get("/v1/auth/me").expect(401);
    await otherSession.agent.post("/v1/auth/refresh").expect(401);
    expect((await login(owner.email, password)).res.status).toBe(401);
    expect((await login(owner.email, newPassword)).res.status).toBe(200);
    expect((await login(a.admin.email)).res.status).toBe(200);
    expect(await adminDb().platformAudit.count({ where: { actorId: owner.id, targetId: owner.id, action: "security.password.changed" } })).toBeGreaterThan(0);
  });

});
