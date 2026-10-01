import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions,
  verifyAuthenticationResponse, type RegistrationResponseJSON, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { config, jwtSecret } from "../../config.js";
import { ApiError } from "../../lib/errors.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import { verifyPassword, hashPassword } from "../../lib/passwords.js";
import { randomToken, sha256 } from "../../lib/tokens.js";
import { createSession } from "../auth/service.js";

const ctx = { rol: "auth" as const };
const origin = new URL(config.SUPER_ADMIN_URL).origin;
const rpID = new URL(origin).hostname;
const invalid = () => new ApiError("UNAUTHORIZED", "Credenciales o código de seguridad incorrectos.");
function encryptionKey() {
  if (config.NODE_ENV === "production" && !config.SECURITY_ENCRYPTION_KEY) {
    throw new ApiError("CONFLICT", "Falta configurar la clave de cifrado de seguridad en el servidor.");
  }
  return config.SECURITY_ENCRYPTION_KEY ? Buffer.from(config.SECURITY_ENCRYPTION_KEY, "hex")
    : createHash("sha256").update(`ubikka-security:${jwtSecret}`).digest();
}
function encrypt(value: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  return Buffer.concat([iv,
    cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
}
function decrypt(value: string) {
  const data = Buffer.from(value, "base64"), decipher = createDecipheriv("aes-256-gcm", encryptionKey(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString("utf8");
}
function totp(secret: string, email = "") {
  return new OTPAuth.TOTP({ issuer: "Ubikka", label: email, algorithm: "SHA1", digits: 6, period: 30, secret });
}
export async function audit(tx: Tx, actorId: string, action: string, targetId = actorId) {
  await tx.platformAudit.createMany({ data: { actorId, action, targetId } });
}
export async function revoke(tx: Tx, userId: string) {
  await tx.user.update({ where: { id: userId }, data: { authVersion: { increment: 1 } } });
  await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
export async function verifySecondFactor(tx: Tx, userId: string, code?: string) {
  await tx.$queryRaw`SELECT user_id FROM user_security WHERE user_id = ${userId}::uuid FOR UPDATE`;
  const security = await tx.userSecurity.findUnique({ where: { userId } });
  if (!security?.enabled) return;
  if (!code) throw new ApiError("UNAUTHORIZED", "Ingresá el código de tu autenticador o un código de recuperación.");
  const normalized = code.trim();
  const recovery = sha256(normalized.toUpperCase());
  if (security.recoveryHashes.includes(recovery)) {
    const used = await tx.userSecurity.updateMany({ where: { userId, recoveryHashes: { has: recovery } },
      data: { recoveryHashes: security.recoveryHashes.filter((hash) => hash !== recovery) } });
    if (!used.count) throw invalid();
    return;
  }
  const delta = totp(decrypt(security.secret!)).validate({ token: normalized, window: 1 });
  if (delta === null) throw invalid();
  const step = Math.floor(Date.now() / 30000) + delta;
  const used = await tx.userSecurity.updateMany({ where: { userId, lastStep: { lt: step } }, data: { lastStep: step } });
  if (!used.count) throw new ApiError("UNAUTHORIZED", "Ese código ya fue utilizado. Esperá el próximo código.");
}
async function verifyOwner(tx: Tx, userId: string, password: string, otp?: string) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user || user.rol !== "super_admin" || user.estado !== "activo" || user.deletedAt ||
      !await verifyPassword(user.passwordHash, password)) throw invalid();
  await verifySecondFactor(tx, userId, otp);
  return user;
}
export async function securityStatus(userId: string) {
  return runWithContext(ctx, async (tx) => {
    const [security, passkeys] = await Promise.all([
      tx.userSecurity.findUnique({ where: { userId }, select: { enabled: true, recoveryHashes: true } }),
      tx.passkey.findMany({ where: { userId }, select: { id: true, nombre: true, createdAt: true } })
    ]);
    return { twoFactorEnabled: security?.enabled ?? false, recoveryCodesRemaining: security?.recoveryHashes.length ?? 0, passkeys };
  });
}
export async function setupTotp(userId: string, password: string) {
  return runWithContext(ctx, async (tx) => {
    const security = await tx.userSecurity.findUnique({ where: { userId } });
    if (security?.enabled) throw new ApiError("CONFLICT", "2FA ya está activado.");
    const user = await verifyOwner(tx, userId, password);
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const data = { pendingSecret: encrypt(secret), pendingExpiresAt: new Date(Date.now() + 600000) };
    await tx.userSecurity.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    return { secret, uri: totp(secret, user.email).toString() };
  });
}
export async function enableTotp(userId: string, code: string) {
  return runWithContext(ctx, async (tx) => {
    const security = await tx.userSecurity.findUnique({ where: { userId } });
    if (!security?.pendingSecret || !security.pendingExpiresAt || security.pendingExpiresAt < new Date() || security.enabled) throw invalid();
    const delta = totp(decrypt(security.pendingSecret)).validate({ token: code, window: 1 });
    if (delta === null) throw invalid();
    const recoveryCodes = Array.from({ length: 10 }, () => randomBytes(8).toString("hex").toUpperCase());
    const updated = await tx.userSecurity.updateMany({ where: { userId, enabled: false, pendingSecret: security.pendingSecret },
      data: { enabled: true, secret: security.pendingSecret, pendingSecret: null, pendingExpiresAt: null,
        lastStep: Math.floor(Date.now() / 30000) + delta, recoveryHashes: recoveryCodes.map(sha256) } });
    if (!updated.count) throw invalid();
    await revoke(tx, userId);
    await audit(tx, userId, "security.2fa.enabled");
    return { recoveryCodes };
  });
}
export async function disableTotp(userId: string, password: string, otp: string) {
  return runWithContext(ctx, async (tx) => {
    await verifyOwner(tx, userId, password, otp);
    await tx.userSecurity.deleteMany({ where: { userId } });
    await revoke(tx, userId);
    await audit(tx, userId, "security.2fa.disabled");
    return { ok: true };
  });
}
export async function changeOwnPassword(userId: string, password: string, newPassword: string, otp?: string) {
  return runWithContext(ctx, async (tx) => {
    await verifyOwner(tx, userId, password, otp);
    await tx.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } });
    await revoke(tx, userId);
    await audit(tx, userId, "security.password.changed");
    return { ok: true };
  });
}
async function saveChallenge(tx: Tx, kind: string, challenge: string, userId?: string) {
  const id = randomToken();
  await tx.authChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await tx.authChallenge.create({ data: { id: sha256(id), kind, challenge, userId, expiresAt: new Date(Date.now() + 300000) } });
  return id;
}
async function consumeChallenge(id: string, kind: string, userId?: string) {
  return runWithContext(ctx, async (tx) => {
    const where = { id: sha256(id), kind, ...(userId ? { userId } : {}), expiresAt: { gt: new Date() } };
    const found = await tx.authChallenge.findFirst({ where });
    if (!found || !(await tx.authChallenge.deleteMany({ where })).count) throw invalid();
    return found;
  });
}
export async function registrationOptions(userId: string, password: string, otp?: string) {
  return runWithContext(ctx, async (tx) => {
    const user = await verifyOwner(tx, userId, password, otp);
    const keys = await tx.passkey.findMany({ where: { userId } });
    if (keys.length >= 10) throw new ApiError("LIMIT_EXCEEDED", "Podés registrar hasta 10 passkeys.");
    const options = await generateRegistrationOptions({ rpName: "Ubikka", rpID, userName: user.email,
      userDisplayName: user.nombre, userID: new Uint8Array(Buffer.from(user.id)), attestationType: "none",
      excludeCredentials: keys.map((key) => ({ id: key.id })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" } });
    return { options, challengeId: await saveChallenge(tx, "register", options.challenge, userId) };
  });
}
export async function registerPasskey(userId: string, challengeId: string, response: RegistrationResponseJSON, nombre: string) {
  const challenge = await consumeChallenge(challengeId, "register", userId);
  let result;
  try { result = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }); }
  catch { throw invalid(); }
  if (!result.verified || !result.registrationInfo) throw invalid();
  const { credential } = result.registrationInfo;
  return runWithContext(ctx, async (tx) => {
    await tx.passkey.create({ data: { id: credential.id, userId, publicKey: Buffer.from(credential.publicKey),
      counter: BigInt(credential.counter), transports: credential.transports ?? [], nombre } });
    await audit(tx, userId, "security.passkey.created");
    return { ok: true };
  });
}
export async function authenticationOptions() {
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  return runWithContext(ctx, async (tx) => ({ options, challengeId: await saveChallenge(tx, "login", options.challenge) }));
}
export async function authenticatePasskey(challengeId: string, response: AuthenticationResponseJSON, userAgent?: string) {
  const challenge = await consumeChallenge(challengeId, "login");
  return runWithContext(ctx, async (tx) => {
    const key = await tx.passkey.findUnique({ where: { id: response.id }, include: { user: true } });
    if (!key || key.user.rol !== "super_admin" || key.user.estado !== "activo" || key.user.deletedAt) throw invalid();
    let result;
    try { result = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge,
      expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: key.id, publicKey: new Uint8Array(key.publicKey), counter: Number(key.counter) } }); }
    catch { throw invalid(); }
    if (!result.verified) throw invalid();
    const updated = await tx.passkey.updateMany({ where: { id: key.id, counter: key.counter }, data: { counter: BigInt(result.authenticationInfo.newCounter) } });
    if (!updated.count) throw invalid();
    return createSession(tx, key.user, userAgent);
  });
}
export async function removePasskey(userId: string, id: string, password: string, otp?: string) {
  return runWithContext(ctx, async (tx) => {
    await verifyOwner(tx, userId, password, otp);
    if (!(await tx.passkey.deleteMany({ where: { userId, id } })).count) throw new ApiError("NOT_FOUND", "Passkey no encontrada.");
    await revoke(tx, userId);
    await audit(tx, userId, "security.passkey.deleted");
    return { ok: true };
  });
}
