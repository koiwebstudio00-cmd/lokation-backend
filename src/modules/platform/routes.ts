import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../../config.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { setAuthCookies } from "../../lib/cookies.js";
import * as platform from "./service.js";
import * as security from "./security.js";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
export const platformRoutes = Router();
platformRoutes.use(["/platform", "/auth/passkey"], (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
const limiter: RequestHandler = config.NODE_ENV === "test" ? (_req, _res, next) => next() : rateLimit({ windowMs: 60000, limit: 10, standardHeaders: true, legacyHeaders: false });
const uuid = z.string().uuid();
const password = z.string().min(12).max(72);
const proof = z.object({ password: z.string().min(1).max(72), otp: z.string().max(100).optional() });
const credential = z.object({ id: z.string().min(1), rawId: z.string(), type: z.literal("public-key"), response: z.record(z.unknown()), clientExtensionResults: z.record(z.unknown()) }).passthrough();
platformRoutes.post("/auth/passkey/options", limiter, async (_req, res) => res.json(await security.authenticationOptions()));
platformRoutes.post("/auth/passkey/verify", limiter, async (req, res) => {
  const body = z.object({ challengeId: z.string().length(64), response: credential }).parse(req.body);
  const session = await security.authenticatePasskey(body.challengeId, body.response as unknown as AuthenticationResponseJSON, req.get("user-agent"));
  setAuthCookies(res, session); res.json({ user: session.user, csrf_token: session.csrf });
});
platformRoutes.use("/platform", requireAuth, requireRole("super_admin"));
platformRoutes.get("/platform/stats", async (req, res) => res.json(await platform.statistics(req.auth!)));
platformRoutes.get("/platform/tenants/:id", async (req, res) => res.json({ tenant: await platform.tenantDetail(req.auth!, uuid.parse(req.params.id)) }));
platformRoutes.get("/platform/operators", async (req, res) => res.json({ data: await platform.listOperators(req.auth!) }));
platformRoutes.post("/platform/operators", limiter, async (req, res) => {
  const body = z.object({ nombre: z.string().trim().min(2).max(120), email: z.string().email().max(254), password }).parse(req.body);
  res.status(201).json({ user: await platform.createOperator(req.auth!, body) });
});
platformRoutes.patch("/platform/operators/:id", async (req, res) => {
  const body = z.object({ nombre: z.string().trim().min(2).max(120).optional(), email: z.string().email().max(254).optional(), estado: z.enum(["activo", "inactivo"]).optional() }).strict().parse(req.body);
  res.json({ user: await platform.updateOperator(req.auth!, uuid.parse(req.params.id), body) });
});
platformRoutes.delete("/platform/operators/:id", async (req, res) => res.json({ user: await platform.updateOperator(req.auth!, uuid.parse(req.params.id), {}, true) }));
platformRoutes.get("/platform/security", async (req, res) => res.json(await security.securityStatus(req.auth!.userId)));
platformRoutes.use("/platform/security", limiter);
platformRoutes.post("/platform/security/password", async (req, res) => {
  const body = proof.extend({ newPassword: password }).parse(req.body);
  res.json(await security.changeOwnPassword(req.auth!.userId, body.password, body.newPassword, body.otp));
});
platformRoutes.post("/platform/security/2fa/setup", async (req, res) => res.json(await security.setupTotp(req.auth!.userId, proof.parse(req.body).password)));
platformRoutes.post("/platform/security/2fa/enable", async (req, res) => res.json(await security.enableTotp(req.auth!.userId, z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body).code)));
platformRoutes.post("/platform/security/2fa/disable", async (req, res) => {
  const body = proof.extend({ otp: z.string().min(1).max(100) }).parse(req.body);
  res.json(await security.disableTotp(req.auth!.userId, body.password, body.otp));
});
platformRoutes.post("/platform/security/passkeys/options", async (req, res) => {
  const body = proof.parse(req.body); res.json(await security.registrationOptions(req.auth!.userId, body.password, body.otp));
});
platformRoutes.post("/platform/security/passkeys/verify", async (req, res) => {
  const body = z.object({ challengeId: z.string().length(64), response: credential, nombre: z.string().trim().min(1).max(100) }).parse(req.body);
  res.json(await security.registerPasskey(req.auth!.userId, body.challengeId, body.response as unknown as RegistrationResponseJSON, body.nombre));
});
platformRoutes.post("/platform/security/passkeys/remove", async (req, res) => {
  const body = proof.extend({ id: z.string().min(1).max(1024) }).parse(req.body);
  res.json(await security.removePasskey(req.auth!.userId, body.id, body.password, body.otp));
});
