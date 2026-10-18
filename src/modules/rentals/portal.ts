import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { runWithContext } from "../../lib/prisma.js";
import { randomToken, sha256, addDays, addHours } from "../../lib/tokens.js";
import { hashPassword, verifyPassword } from "../../lib/passwords.js";
import { mailConfigured, sendMail } from "../../lib/mailer.js";
import { config } from "../../config.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { readRentalPdf } from "../../lib/rental-documents-storage.js";

type PortalIdentity = { accountId: string; tenantId: string; slug: string };
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { portal?: PortalIdentity } }
}

export const rentalPortalRoutes = Router();
const uuid = z.string().uuid();
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/);
const password = z.string().min(10).max(200);
const authCtx = { rol: "auth" as const };
const limiter: RequestHandler = config.NODE_ENV === "test" ? (_req, _res, next) => next()
  : rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false });

function portalCtx(req: import("express").Request) {
  if (!req.portal) throw new ApiError("UNAUTHORIZED", "Iniciá sesión en el portal.");
  return { tenantId: req.portal.tenantId, userId: req.portal.accountId, rol: "portal" as const };
}

const requirePortal: RequestHandler = async (req, _res, next) => {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(req.get("authorization") ?? "");
  if (!match) throw new ApiError("UNAUTHORIZED", "Iniciá sesión en el portal.");
  const requestedSlug = slug.parse(req.params.slug);
  const session = await runWithContext(authCtx, (tx) => tx.rentalPortalSession.findUnique({
    where: { tokenHash: sha256(match[1]!) }, include: {
      tenant: { select: { slug: true, estado: true } },
      account: { select: { active: true, accesses: { where: { active: true }, select: { tenantId: true } } } }
    }
  }));
  if (!session || session.revokedAt || session.expiresAt <= new Date()
    || !session.account.active || session.tenant.estado !== "activo"
    || session.tenant.slug !== requestedSlug
    || !session.account.accesses.some((access) => access.tenantId === session.tenantId)) {
    throw new ApiError("UNAUTHORIZED", "La sesión del portal venció o fue revocada.");
  }
  req.portal = { accountId: session.accountId, tenantId: session.tenantId, slug: requestedSlug };
  next();
};

rentalPortalRoutes.get("/portal/:slug/brand", async (req, res) => {
  const tenant = await runWithContext(authCtx, (tx) => tx.tenant.findUnique({
    where: { slug: slug.parse(req.params.slug) }, select: { id: true, nombre: true,
      logoUrl: true, configSitio: true, estado: true }
  }));
  if (!tenant || tenant.estado !== "activo") throw new ApiError("NOT_FOUND", "Portal no disponible.");
  const site = tenant.configSitio && typeof tenant.configSitio === "object" && !Array.isArray(tenant.configSitio)
    ? tenant.configSitio as Record<string, unknown> : {};
  const color = typeof site.color_primario === "string" && /^#[0-9a-fA-F]{6}$/.test(site.color_primario)
    ? site.color_primario : null;
  res.set("Cache-Control", "no-store").json({ brand: { nombre: tenant.nombre, logo_url: tenant.logoUrl, color_primario: color } });
});

rentalPortalRoutes.post("/rental-people/:id/portal-invite", requireAuth, requireRole("admin"), async (req, res) => {
  const personId = uuid.parse(req.params.id);
  const auth = req.auth!;
  const person = await runWithContext({ tenantId: auth.tenantId!, userId: auth.userId, rol: "admin" }, async (tx) => {
    const person = await tx.rentalPerson.findUnique({ where: { id: personId } });
    if (!person) throw new ApiError("NOT_FOUND", "La persona no existe.");
    if (!person.email) throw new ApiError("VALIDATION_ERROR", "La persona necesita un correo para recibir acceso.");
    const linked = await tx.rentalContract.count({ where: {
      status: "vigente", OR: [{ ownerPersonId: personId }, { tenantPersonId: personId }]
    } });
    if (!linked) throw new ApiError("CONFLICT", "La persona necesita un contrato vigente antes de invitarla.");
    return person;
  });
  if (config.NODE_ENV === "production" && !mailConfigured()) {
    throw new ApiError("CONFLICT", "Configurá el correo antes de enviar invitaciones al portal.");
  }
  const token = randomToken();
  const tenant = await runWithContext(authCtx, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId! }, select: { slug: true, nombre: true } });
    await tx.rentalPortalInvitation.create({ data: {
      tenantId: auth.tenantId!, personId, createdById: auth.userId,
      email: person.email!, tokenHash: sha256(token), expiresAt: addDays(7)
    } });
    return tenant;
  });
  const path = `/portal/${tenant.slug}/activar?token=${token}`;
  const delivered = await sendMail({ to: person.email!, subject: `Acceso al portal de ${tenant.nombre}`,
    text: `Te invitaron a consultar tus alquileres en ${tenant.nombre}.\n\nActivá el acceso (vence en 7 días):\n${config.FRONT_URL}${path}` });
  if (!delivered && config.NODE_ENV === "production") {
    await runWithContext(authCtx, (tx) => tx.rentalPortalInvitation.delete({ where: { tokenHash: sha256(token) } }));
    throw new ApiError("CONFLICT", "El correo no pudo enviarse. Intentá nuevamente.");
  }
  res.status(201).json({ sent: delivered, ...(config.NODE_ENV === "production" ? {} : { dev_accept_url: path }) });
});

rentalPortalRoutes.post("/portal/invitations/accept", limiter, async (req, res) => {
  const body = z.object({ token: z.string().min(32).max(128), password, slug }).strict().parse(req.body);
  const result = await runWithContext(authCtx, async (tx) => {
    const invitation = await tx.rentalPortalInvitation.findUnique({ where: { tokenHash: sha256(body.token) },
      include: { tenant: { select: { slug: true, estado: true } }, person: { select: { email: true } } } });
    if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()
      || invitation.tenant.estado !== "activo" || invitation.tenant.slug !== body.slug || !invitation.person.email
      || invitation.person.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new ApiError("UNAUTHORIZED", "La invitación venció o ya no es válida.");
    }
    const existing = await tx.rentalPortalAccount.findUnique({ where: { email: invitation.email } });
    if (existing && (!existing.active || !(await verifyPassword(existing.passwordHash, body.password)))) {
      throw new ApiError("UNAUTHORIZED", "La contraseña de esta cuenta no coincide.");
    }
    const account = existing ?? await tx.rentalPortalAccount.create({ data: {
      email: invitation.email, passwordHash: await hashPassword(body.password)
    } });
    await tx.rentalPortalAccess.upsert({ where: { tenantId_personId: {
      tenantId: invitation.tenantId, personId: invitation.personId
    } }, update: { accountId: account.id, active: true }, create: {
      tenantId: invitation.tenantId, personId: invitation.personId, accountId: account.id
    } });
    await tx.rentalPortalInvitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
    return { slug: invitation.tenant.slug };
  });
  res.status(201).json(result);
});

rentalPortalRoutes.post("/portal/:slug/login", limiter, async (req, res) => {
  const tenantSlug = slug.parse(req.params.slug);
  const body = z.object({ email: z.string().email(), password: z.string().min(1) }).strict().parse(req.body);
  const result = await runWithContext(authCtx, async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { slug: tenantSlug } });
    const account = await tx.rentalPortalAccount.findUnique({ where: { email: body.email } });
    if (!tenant || tenant.estado !== "activo" || !account?.active
      || !(await verifyPassword(account.passwordHash, body.password))
      || !await tx.rentalPortalAccess.count({ where: { tenantId: tenant.id, accountId: account.id, active: true } })) {
      throw new ApiError("UNAUTHORIZED", "Correo o contraseña incorrectos.");
    }
    const token = randomToken();
    await tx.rentalPortalSession.create({ data: {
      tenantId: tenant.id, accountId: account.id, tokenHash: sha256(token), expiresAt: addDays(7)
    } });
    return { token, expires_in: 7 * 24 * 60 * 60 };
  });
  res.set("Cache-Control", "no-store").json(result);
});

rentalPortalRoutes.post("/portal/:slug/forgot-password", limiter, async (req, res) => {
  const requestedSlug = slug.parse(req.params.slug);
  const { email } = z.object({ email: z.string().email() }).strict().parse(req.body);
  if (config.NODE_ENV === "production" && !mailConfigured()) {
    throw new ApiError("CONFLICT", "El correo del portal no está configurado.");
  }
  const result = await runWithContext(authCtx, async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { slug: requestedSlug } });
    const account = await tx.rentalPortalAccount.findUnique({ where: { email } });
    if (!tenant || tenant.estado !== "activo" || !account?.active ||
      !await tx.rentalPortalAccess.count({ where: { tenantId: tenant.id, accountId: account.id, active: true } })) return null;
    const token = randomToken();
    await tx.rentalPortalPasswordReset.create({ data: { tenantId: tenant.id, accountId: account.id,
      tokenHash: sha256(token), expiresAt: addHours(1) } });
    return { token, to: account.email, tenantName: tenant.nombre };
  });
  if (result) {
    const path = `/portal/${requestedSlug}/restablecer?token=${result.token}`;
    const sent = await sendMail({ to: result.to, subject: `Restablecer acceso a ${result.tenantName}`,
      text: `Para crear una contraseña nueva abrí este enlace (vence en 1 hora):\n${config.FRONT_URL}${path}\n\nSi no lo pediste, ignorá este mensaje.` });
    if (!sent && config.NODE_ENV === "production") throw new ApiError("CONFLICT", "No pudimos enviar el correo.");
    if (config.NODE_ENV !== "production") { res.json({ ok: true, dev_reset_url: path }); return; }
  }
  res.json({ ok: true });
});

rentalPortalRoutes.post("/portal/:slug/reset-password", limiter, async (req, res) => {
  const requestedSlug = slug.parse(req.params.slug);
  const body = z.object({ token: z.string().min(32).max(128), password }).strict().parse(req.body);
  await runWithContext(authCtx, async (tx) => {
    const reset = await tx.rentalPortalPasswordReset.findUnique({ where: { tokenHash: sha256(body.token) },
      include: { tenant: { select: { slug: true, estado: true } } } });
    if (!reset || reset.consumedAt || reset.expiresAt <= new Date() || reset.tenant.slug !== requestedSlug
      || reset.tenant.estado !== "activo") throw new ApiError("UNAUTHORIZED", "El enlace venció o ya fue usado.");
    const { count } = await tx.rentalPortalPasswordReset.updateMany({ where: { id: reset.id, consumedAt: null },
      data: { consumedAt: new Date() } });
    if (!count) throw new ApiError("UNAUTHORIZED", "El enlace ya fue usado.");
    await tx.rentalPortalAccount.update({ where: { id: reset.accountId },
      data: { passwordHash: await hashPassword(body.password) } });
    await tx.rentalPortalSession.updateMany({ where: { accountId: reset.accountId, revokedAt: null },
      data: { revokedAt: new Date() } });
  });
  res.json({ ok: true });
});

rentalPortalRoutes.use("/portal/:slug", requirePortal);

rentalPortalRoutes.post("/portal/:slug/logout", async (req, res) => {
  const token = (req.get("authorization") ?? "").slice(7);
  await runWithContext(authCtx, (tx) => tx.rentalPortalSession.updateMany({
    where: { tokenHash: sha256(token), accountId: req.portal!.accountId }, data: { revokedAt: new Date() }
  }));
  res.json({ ok: true });
});

rentalPortalRoutes.get("/portal/:slug/me", async (req, res) => {
  const account = await runWithContext(authCtx, (tx) => tx.rentalPortalAccount.findUniqueOrThrow({
    where: { id: req.portal!.accountId }, select: { email: true }
  }));
  res.json({ account, tenant: req.portal!.slug });
});

rentalPortalRoutes.get("/portal/:slug/contracts", async (req, res) => {
  const data = await runWithContext(portalCtx(req), (tx) => tx.rentalContract.findMany({
    select: { id: true, status: true, startDate: true, endDate: true, monthlyRent: true,
      currency: true, dueDay: true, property: { select: { titulo: true } } },
    orderBy: { createdAt: "desc" }
  }));
  res.json({ data });
});

rentalPortalRoutes.get("/portal/:slug/contracts/:id", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const result = await runWithContext(portalCtx(req), async (tx) => {
    const contract = await tx.rentalContract.findUnique({ where: { id }, include: {
      property: { select: { id: true, titulo: true } }, owner: { select: { nombre: true } },
      tenantPerson: { select: { nombre: true } }
    } });
    if (!contract) throw new ApiError("NOT_FOUND", "El contrato no está disponible.");
    const roleRows = await tx.$queryRaw<{ role: string | null }[]>`SELECT portal_contract_role(${id}::uuid) AS role`;
    const role = roleRows[0]?.role;
    const [charges, adjustments, settlements, services, maintenance, inquiries, documents] = await Promise.all([
      tx.rentalCharge.findMany({ where: { contractId: id }, include: { payments: { where: { voidedAt: null },
        select: { amount: true, paidAt: true, method: true, reference: true } } }, orderBy: { period: "desc" } }),
      tx.rentalAdjustment.findMany({ where: { contractId: id }, orderBy: { effectivePeriod: "desc" } }),
      role === "propietario" ? tx.rentalSettlement.findMany({ where: { contractId: id },
        select: { id: true, gross: true, commission: true, expenses: true, net: true, currency: true,
          status: true, paidAt: true, charge: { select: { period: true } } }, orderBy: { createdAt: "desc" } }) : Promise.resolve([]),
      tx.rentalServiceAccount.findMany({ where: { propertyId: contract.propertyId },
        select: { id: true, type: true, provider: true, accountNumber: true, meterNumber: true } }),
      tx.maintenanceRequest.findMany({ where: { contractId: id },
        select: { id: true, title: true, status: true, createdAt: true }, orderBy: { createdAt: "desc" } }),
      tx.rentalInquiry.findMany({ where: { contractId: id }, orderBy: { createdAt: "desc" } }),
      tx.rentalDocument.findMany({ where: { contractId: id },
        select: { id: true, title: true, kind: true, size: true, createdAt: true }, orderBy: { createdAt: "desc" } })
    ]);
    return { contract, role, charges, adjustments, settlements, services, maintenance, inquiries, documents };
  });
  res.json(result);
});

rentalPortalRoutes.post("/portal/:slug/contracts/:id/inquiries", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = z.object({ category: z.enum(["consulta", "reclamo"]), title: z.string().trim().min(5).max(160),
    description: z.string().trim().min(10).max(5000) }).strict().parse(req.body);
  const item = await runWithContext(portalCtx(req), async (tx) => {
    const contract = await tx.rentalContract.findUnique({ where: { id }, select: { status: true } });
    if (!contract) throw new ApiError("NOT_FOUND", "El contrato no está disponible.");
    if (contract.status !== "vigente") throw new ApiError("CONFLICT", "Sólo se reciben consultas de contratos vigentes.");
    return tx.rentalInquiry.create({ data: { tenantId: req.portal!.tenantId, contractId: id,
      accountId: req.portal!.accountId, ...body } });
  });
  res.status(201).json({ item });
});

rentalPortalRoutes.get("/portal/:slug/documents/:id/content", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const document = await runWithContext(portalCtx(req), (tx) => tx.rentalDocument.findUnique({
    where: { id }, select: { storageKey: true }
  }));
  if (!document) throw new ApiError("NOT_FOUND", "El documento no está disponible.");
  const bytes = await readRentalPdf(document.storageKey);
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=\"documento.pdf\"",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).send(bytes);
});

rentalPortalRoutes.get("/rental-people/:id/portal-access", requireAuth, requireRole("admin"), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const auth = req.auth!;
  const access = await runWithContext({ tenantId: auth.tenantId!, userId: auth.userId, rol: "admin" }, async (tx) => {
    const person = await tx.rentalPerson.findUnique({ where: { id }, select: { id: true } });
    if (!person) throw new ApiError("NOT_FOUND", "La persona no existe.");
    return tx.rentalPortalAccess.findUnique({ where: { tenantId_personId: {
      tenantId: auth.tenantId!, personId: id
    } }, select: { active: true, account: { select: { email: true } } } });
  });
  res.json({ access });
});

rentalPortalRoutes.delete("/rental-people/:id/portal-access", requireAuth, requireRole("admin"), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const auth = req.auth!;
  const person = await runWithContext({ tenantId: auth.tenantId!, userId: auth.userId, rol: "admin" },
    (tx) => tx.rentalPerson.findUnique({ where: { id }, select: { id: true } }));
  if (!person) throw new ApiError("NOT_FOUND", "La persona no existe.");
  await runWithContext(authCtx, (tx) => tx.rentalPortalAccess.updateMany({
    where: { tenantId: auth.tenantId!, personId: id }, data: { active: false }
  }));
  res.json({ ok: true });
});
