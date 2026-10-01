import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { buildApp } from "../src/app.js";
import { setupTotp } from "../src/modules/platform/security.js";
import { config } from "../src/config.js";
import { sha256 } from "../src/lib/tokens.js";
import { runWithContext } from "../src/lib/prisma.js";
import { adminDb, DB_AVAILABLE, seedSuperAdmin, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

const app = buildApp();
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const audience = "ubikka-test.apps.googleusercontent.com";
const originalClient = config.GOOGLE_CLIENT_ID;
function googleToken(email: string, sub: string, claims: Record<string, unknown> = {}) {
  return jwt.sign({ iss: "https://accounts.google.com", aud: audience, sub, email, email_verified: true,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, jti: randomUUID(), ...claims }, privateKey, { algorithm: "RS256", keyid: "test-key" });
}
const start = (email: string, panel = "superadmin", password = TEST_PASSWORD) => request(app).post("/v1/auth/login/start").send({ email, password, panel });
const verify = (challenge: string, otp: string, panel = "superadmin") => request(app).post("/v1/auth/login/verify").send({ challenge, otp, panel });
const google = (idToken: string, panel = "superadmin") => request(app).post("/v1/auth/google").send({ idToken, panel });

describe.runIf(DB_AVAILABLE)("Login en dos pasos y Google", () => {
  let owner: Awaited<ReturnType<typeof seedSuperAdmin>>;
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  beforeAll(() => {
    config.GOOGLE_CLIENT_ID = audience;
    // Sustituimos solo la descarga de certificados: la firma RSA, issuer,
    // audience y expiración los verifica la librería oficial de Google.
    vi.spyOn(OAuth2Client.prototype, "getFederatedSignonCertsAsync").mockResolvedValue({
      certs: { "test-key": publicKey.export({ type: "spki", format: "pem" }).toString() },
      format: "PEM" as never
    });
  });
  afterAll(() => { config.GOOGLE_CLIENT_ID = originalClient; vi.restoreAllMocks(); });
  beforeEach(async () => {
    await truncateAll(); owner = await seedSuperAdmin(); a = await seedTenantWithUsers("login-a"); b = await seedTenantWithUsers("login-b");
    owner = await adminDb().user.update({ where: { id: owner.id }, data: { email: "owner@gmail.com" } });
    await adminDb().user.update({ where: { id: a.admin.id }, data: { email: "admin-a@gmail.com" } });
    await adminDb().user.update({ where: { id: b.admin.id }, data: { email: "admin-b@gmail.com" } });
  });
  async function enableRecovery() {
    await setupTotp(owner.id, TEST_PASSWORD);
    const pending = await adminDb().userSecurity.findUniqueOrThrow({ where: { userId: owner.id } });
    await adminDb().userSecurity.update({ where: { userId: owner.id }, data: { enabled: true, secret: pending.pendingSecret, pendingSecret: null, recoveryHashes: [sha256("RECOVERY-ONE"), sha256("RECOVERY-TWO")] } });
  }
  it("sin 2FA abre sesión; rechaza contraseña incorrecta y panel incorrecto", async () => {
    expect((await start(owner.email)).body.user.id).toBe(owner.id);
    expect((await start(owner.email, "superadmin", "incorrecta")).status).toBe(401);
    expect((await start(owner.email, "dashboard")).status).toBe(403);
    expect((await start("admin-a@gmail.com", "superadmin")).status).toBe(403);
    expect((await start("admin-a@gmail.com", "dashboard")).body.user.tenantId).toBe(a.tenant.id);
  });
  it("no entrega sesión antes del 2FA; desafíos opacos, un solo uso y códigos de recuperación", async () => {
    await enableRecovery();
    const first = await start(owner.email);
    expect(first.status).toBe(200); expect(first.body.twoFactorRequired).toBe(true);
    expect(first.headers["set-cookie"]).toBeUndefined(); expect(first.body.user).toBeUndefined();
    expect(first.headers["cache-control"]).toBe("no-store");
    const stored = await adminDb().authChallenge.findUniqueOrThrow({ where: { id: sha256(first.body.challenge) } });
    expect(stored.challenge).not.toContain(TEST_PASSWORD);
    expect((await verify(first.body.challenge, "RECOVERY-ONE", "dashboard")).status).toBe(401);
    const results = await Promise.all([verify(first.body.challenge, "RECOVERY-ONE"), verify(first.body.challenge, "RECOVERY-ONE")]);
    expect(results.map(r => r.status).sort()).toEqual([200, 401]);
    expect((await verify(first.body.challenge, "RECOVERY-TWO")).status).toBe(401);
    const next = await start(owner.email); expect(next.body.twoFactorRequired).toBe(true);
    expect((await verify(next.body.challenge, "RECOVERY-TWO")).status).toBe(200);
  });
  it("vence, limita cinco intentos y rechaza cambios de cuenta durante el paso intermedio", async () => {
    await enableRecovery();
    let pending = await start(owner.email);
    for (let i = 0; i < 5; i++) expect((await verify(pending.body.challenge, "bad")).status).toBe(401);
    expect((await verify(pending.body.challenge, "RECOVERY-ONE")).status).toBe(401);
    pending = await start(owner.email);
    await adminDb().authChallenge.update({ where: { id: sha256(pending.body.challenge) }, data: { expiresAt: new Date(0) } });
    expect((await verify(pending.body.challenge, "RECOVERY-ONE")).status).toBe(401);
    pending = await start(owner.email);
    await adminDb().user.update({ where: { id: owner.id }, data: { authVersion: { increment: 1 } } });
    expect((await verify(pending.body.challenge, "RECOVERY-ONE")).status).toBe(401);
  });
  it("Google exige firma, issuer, audiencia, email verificado y cuenta registrada", async () => {
    for (const claims of [{ aud: "otro-cliente" }, { iss: "https://attacker.test" }, { email_verified: false }, { exp: Math.floor(Date.now()/1000)-400 }, { iat: Math.floor(Date.now()/1000)-400 }]) {
      expect((await google(googleToken(owner.email, "owner-sub", claims))).status).toBe(401);
    }
    const token = googleToken(owner.email, "owner-sub");
    const parts = token.split("."); parts[2] = "invalid";
    expect((await google(parts.join("."))).status).toBe(401);
    expect((await google(googleToken("unknown@gmail.com", "unknown"))).status).toBe(403);
    await adminDb().user.update({ where: { id: owner.id }, data: { email: "owner@example.com" } });
    expect((await google(googleToken("owner@example.com", "owner-sub"))).status).toBe(403);
  });
  it("Google vincula subject, evita replay, respeta 2FA y suspensión", async () => {
    await enableRecovery();
    const token = googleToken(owner.email, "owner-sub");
    const pending = await google(token);
    expect(pending.status).toBe(200); expect(pending.body.twoFactorRequired).toBe(true); expect(pending.headers["set-cookie"]).toBeUndefined();
    expect((await google(token)).status).toBe(401);
    expect((await verify(pending.body.challenge, "RECOVERY-ONE")).status).toBe(200);
    expect((await adminDb().user.findUniqueOrThrow({ where: { id: owner.id } })).googleSubject).toBe("owner-sub");
    expect((await google(googleToken(owner.email, "different-sub"))).status).toBe(403);
    await adminDb().user.update({ where: { id: owner.id }, data: { estado: "inactivo" } });
    expect((await google(googleToken(owner.email, "owner-sub"))).status).toBe(401);
  });
  it("dos tenants con Google mantienen aislamiento y no acceden al panel global", async () => {
    for (const [tenant, email, sub] of [[a, "admin-a@gmail.com", "a-sub"], [b, "admin-b@gmail.com", "b-sub"]] as const) {
      expect((await google(googleToken(email, sub))).status).toBe(403);
      const agent = request.agent(app);
      const res = await agent.post("/v1/auth/google").send({ idToken: googleToken(email, sub), panel: "dashboard" });
      expect(res.status).toBe(200); expect(res.body.user.tenantId).toBe(tenant.tenant.id);
      expect((await agent.get("/v1/platform/stats")).status).toBe(403);
      const challenges = await runWithContext({ rol: "admin", tenantId: tenant.tenant.id, userId: tenant.admin.id }, tx => tx.authChallenge.findMany());
      expect(challenges).toEqual([]);
    }
    await adminDb().tenant.update({ where: { id: a.tenant.id }, data: { estado: "suspendido" } });
    expect((await google(googleToken("admin-a@gmail.com", "a-sub"), "dashboard")).status).toBe(403);
  });
});
