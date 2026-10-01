import { OAuth2Client } from "google-auth-library";
import { config } from "../../config.js";
import { ApiError } from "../../lib/errors.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import { verifyPassword } from "../../lib/passwords.js";
import { randomToken, sha256 } from "../../lib/tokens.js";
import { createSession, type Session } from "./service.js";
import { verifySecondFactor } from "../platform/security.js";
import type { User } from "@prisma/client";

const ctx = { rol: "auth" as const };
export type Panel = "superadmin" | "dashboard";
export type LoginResult = Session | { twoFactorRequired: true; challenge: string };
const invalid = () => new ApiError("UNAUTHORIZED", "Acceso inválido o vencido. Volvé a iniciar sesión.");
const googleClient = new OAuth2Client();

function checkPanel(user: User, panel: Panel) {
  if (user.estado !== "activo" || user.deletedAt) throw invalid();
  if ((user.rol === "super_admin") !== (panel === "superadmin")) {
    throw new ApiError("FORBIDDEN", "Esta cuenta no tiene acceso a este panel.");
  }
}

async function continueLogin(tx: Tx, user: User, panel: Panel, userAgent?: string): Promise<LoginResult> {
  checkPanel(user, panel);
  if (user.tenantId) {
    const tenant = await tx.tenant.findUnique({ where: { id: user.tenantId } });
    if (!tenant || tenant.estado !== "activo") throw new ApiError("FORBIDDEN", "La inmobiliaria está suspendida.");
  }
  const security = await tx.userSecurity.findUnique({ where: { userId: user.id } });
  if (!security?.enabled) return createSession(tx, user, userAgent);
  const challenge = randomToken();
  await tx.authChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await tx.authChallenge.create({ data: { id: sha256(challenge), userId: user.id, kind: "second-factor",
    challenge: JSON.stringify({ version: user.authVersion, panel }), expiresAt: new Date(Date.now() + 300_000) } });
  return { twoFactorRequired: true, challenge };
}

export async function beginPasswordLogin(email: string, password: string, panel: Panel, userAgent?: string) {
  return runWithContext(ctx, async tx => {
    const user = await tx.user.findFirst({ where: { email: { equals: email.trim(), mode: "insensitive" }, estado: "activo", deletedAt: null } });
    if (!user || !await verifyPassword(user.passwordHash, password)) throw new ApiError("UNAUTHORIZED", "Email o contraseña incorrectos.");
    return continueLogin(tx, user, panel, userAgent);
  });
}

export async function finishSecondFactor(challenge: string, otp: string, panel: Panel, userAgent?: string) {
  const id = sha256(challenge);
  // Persistir intentos incluso si la verificación falla; no devolverlos con rollback.
  const attempt = await runWithContext(ctx, tx => tx.authChallenge.updateMany({
    where: { id, kind: "second-factor", expiresAt: { gt: new Date() }, attempts: { lt: 5 } },
    data: { attempts: { increment: 1 } }
  }));
  if (!attempt.count) throw invalid();
  return runWithContext(ctx, async tx => {
    await tx.$queryRaw`SELECT id FROM auth_challenges WHERE id = ${id} FOR UPDATE`;
    const pending = await tx.authChallenge.findUnique({ where: { id } });
    if (!pending?.userId || pending.kind !== "second-factor" || pending.expiresAt <= new Date()) throw invalid();
    const proof = JSON.parse(pending.challenge) as { version: number; panel: Panel };
    if (proof.panel !== panel) throw invalid();
    const user = await tx.user.findUnique({ where: { id: pending.userId } });
    if (!user || user.authVersion !== proof.version) throw invalid();
    checkPanel(user, panel);
    await verifySecondFactor(tx, user.id, otp);
    const session = await createSession(tx, user, userAgent);
    await tx.authChallenge.delete({ where: { id } });
    return session;
  });
}

export async function beginGoogleLogin(idToken: string, panel: Panel, userAgent?: string) {
  if (!config.GOOGLE_CLIENT_ID) throw new ApiError("CONFLICT", "El acceso con Google todavía no está configurado.");
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: config.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch { throw invalid(); }
  if (!payload?.sub || !payload.email || !payload.email_verified || !payload.exp || !payload.iat || payload.iat < Date.now() / 1000 - 300 || payload.iat > Date.now() / 1000 + 30) throw invalid();
  // Google solo es autoridad del email para Gmail o cuentas Workspace verificadas.
  // Otras direcciones requieren un flujo de vinculación explícito con contraseña.
  const authoritative = payload.email.toLowerCase().endsWith("@gmail.com") || Boolean(payload.hd);
  return runWithContext(ctx, async tx => {
    let user = await tx.user.findUnique({ where: { googleSubject: payload.sub } });
    if (!user) {
      if (!authoritative) throw new ApiError("FORBIDDEN", "Usá tu contraseña. Esta dirección de Google requiere vinculación verificada.");
      const matches = await tx.user.findMany({ where: { email: { equals: payload.email, mode: "insensitive" }, estado: "activo", deletedAt: null }, take: 2 });
      user = matches.length === 1 ? matches[0]! : null;
      if (!user || user.googleSubject) throw new ApiError("FORBIDDEN", "Tu cuenta debe estar registrada y habilitada en Ubikka.");
      checkPanel(user, panel);
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      const linked = await tx.user.updateMany({ where: { id: user.id, googleSubject: null, authVersion: user.authVersion }, data: { googleSubject: payload.sub } });
      if (!linked.count) throw invalid();
    }
    // El ID token no puede abrir más de un flujo de acceso (ni en otro panel).
    const consumed = await tx.authChallenge.createMany({ data: { id: sha256(idToken), kind: "google-used", challenge: "", expiresAt: new Date(payload.exp * 1000) }, skipDuplicates: true });
    if (!consumed.count) throw invalid();
    return continueLogin(tx, user, panel, userAgent);
  });
}
