import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../../config.js";
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from "../../lib/cookies.js";
import { requireAuth } from "../../middleware/auth.js";
import * as auth from "./service.js";

export const authRoutes = Router();

// En test no hay rate limit (los tests hacen muchos logins desde la misma IP).
const limiter: RequestHandler =
  config.NODE_ENV === "test"
    ? (_req, _res, next) => next()
    : rateLimit({
        windowMs: 60_000,
        limit: 5,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) =>
          res.status(429).json({
            error: { code: "RATE_LIMITED", message: "Demasiados intentos. Probá en un minuto." }
          })
      });

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1), otp: z.string().max(100).optional() });
const passwordSchema = z.string().min(8, "La contraseña debe tener al menos 8 caracteres.");

authRoutes.post("/auth/login", limiter, async (req, res) => {
  const { email, password, otp } = loginSchema.parse(req.body);
  const s = await auth.login(email, password, req.get("user-agent") ?? undefined, otp);
  setAuthCookies(res, s);
  res.json({ user: s.user, csrf_token: s.csrf });
});

authRoutes.post("/auth/refresh", async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sesión requerida." } });
    return;
  }
  const s = await auth.refresh(token, req.get("user-agent") ?? undefined);
  setAuthCookies(res, s);
  res.json({ user: s.user, csrf_token: s.csrf });
});

authRoutes.post("/auth/logout", requireAuth, async (req, res) => {
  const body = z.object({ all: z.boolean().optional() }).parse(req.body ?? {});
  await auth.logout(
    req.cookies?.[REFRESH_COOKIE] as string | undefined,
    body.all ?? false,
    req.auth!.userId
  );
  clearAuthCookies(res);
  res.json({ ok: true });
});

authRoutes.post("/auth/forgot-password", limiter, async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  await auth.forgotPassword(email);
  res.json({ ok: true, message: "Si el email existe, vas a recibir un link para restablecer." });
});

authRoutes.post("/auth/reset-password", async (req, res) => {
  const body = z.object({ token: z.string().min(1), password: passwordSchema }).parse(req.body);
  await auth.resetPassword(body.token, body.password);
  res.json({ ok: true });
});

authRoutes.post("/auth/accept-invitation", async (req, res) => {
  const body = z
    .object({ token: z.string().min(1), nombre: z.string().min(1), password: passwordSchema })
    .parse(req.body);
  const s = await auth.acceptInvitation(
    body.token,
    body.nombre,
    body.password,
    req.get("user-agent") ?? undefined
  );
  setAuthCookies(res, s);
  res.status(201).json({ user: s.user, csrf_token: s.csrf });
});

authRoutes.get("/auth/me", requireAuth, async (req, res) => {
  res.json({ user: await auth.me(req.auth!) });
});
