// CLI de operación — tareas de administración que no pasan por la API porque
// necesitan existir ANTES de que haya alguien con sesión (bootstrap) o porque
// son intervenciones de operador (reset manual de contraseña).
//
// Corre con DATABASE_URL_MIGRATE: bypassa RLS a propósito. No exponer nunca
// por HTTP ni empaquetar en la imagen que atiende tráfico público.
//
// Uso:
//   npm run admin -- list [--tenant <slug>]
//   npm run admin -- create-superadmin --email <email> [--nombre "..."] [--password <pass>]
//   npm run admin -- set-rol --email <email> --rol admin|agente
//   npm run admin -- set-password --email <email> [--password <pass>]
//
// Si se omite --password se genera una aleatoria fuerte y se imprime UNA vez
// (recomendado: evita que la contraseña quede en el historial del shell).
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import { runZernioAdoptCli } from "../src/modules/integrations/channel-adoption.cli.js";

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD = 8;

const url = process.env.DATABASE_URL_MIGRATE;
if (!url) throw new Error("Falta DATABASE_URL_MIGRATE en .env");

const prisma = new PrismaClient({ datasources: { db: { url } } });

// ── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string> } {
  const [cmd = "", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) continue;
    const [name, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags[name] = inline;
    } else {
      const next = rest[i + 1];
      flags[name] = next && !next.startsWith("--") ? (i++, next) : "true";
    }
  }
  return { cmd, flags };
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const v = flags[name]?.trim();
  if (!v || v === "true") throw new Error(`Falta --${name}`);
  return v;
}

function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Email inválido: ${raw}`);
  return email;
}

// Contraseña generada: 24 chars base64url ≈ 128 bits de entropía.
function resolvePassword(flags: Record<string, string>): { password: string; generated: boolean } {
  const given = flags.password?.trim();
  if (given && given !== "true") {
    if (given.length < MIN_PASSWORD) {
      throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
    }
    return { password: given, generated: false };
  }
  return { password: randomBytes(18).toString("base64url"), generated: true };
}

function printPassword(email: string, password: string, generated: boolean): void {
  if (!generated) return;
  console.log("\n  ─────────────────────────────────────────────");
  console.log(`  Contraseña de ${email}:`);
  console.log(`    ${password}`);
  console.log("  Se muestra UNA sola vez. Guardala en el gestor de");
  console.log("  contraseñas y cambiala al primer login.");
  console.log("  ─────────────────────────────────────────────\n");
}

// ── comandos ─────────────────────────────────────────────────────────────────

async function slugsByTenantId(): Promise<Map<string, string>> {
  const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true } });
  return new Map(tenants.map((t) => [t.id, t.slug]));
}

async function list(flags: Record<string, string>): Promise<void> {
  const slugs = await slugsByTenantId();
  const rawSlug = flags.tenant?.trim();
  const tenantSlug = rawSlug && rawSlug !== "true" ? rawSlug : undefined;
  let tenantId: string | undefined;
  if (tenantSlug) {
    tenantId = [...slugs.entries()].find(([, slug]) => slug === tenantSlug)?.[0];
    if (!tenantId) throw new Error(`No existe el tenant '${tenantSlug}'.`);
  }

  const users = await prisma.user.findMany({
    where: tenantId ? { tenantId } : undefined,
    select: { email: true, nombre: true, rol: true, estado: true, tenantId: true },
    orderBy: [{ rol: "asc" }, { email: "asc" }]
  });
  if (users.length === 0) {
    console.log("Sin usuarios para ese filtro.");
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(`${pad("EMAIL", 38)} ${pad("ROL", 12)} ${pad("ESTADO", 9)} ${pad("TENANT", 14)} NOMBRE`);
  for (const u of users) {
    const slug = u.tenantId ? (slugs.get(u.tenantId) ?? u.tenantId) : "—";
    console.log(`${pad(u.email, 38)} ${pad(u.rol, 12)} ${pad(u.estado, 9)} ${pad(slug, 14)} ${u.nombre}`);
  }
  console.log(`\n${users.length} usuario(s).`);
}

async function createSuperadmin(flags: Record<string, string>): Promise<void> {
  const email = normalizeEmail(requireFlag(flags, "email"));
  const nombre = flags.nombre?.trim() && flags.nombre !== "true" ? flags.nombre.trim() : "Super Admin";
  const { password, generated } = resolvePassword(flags);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, rol: true }
  });

  if (existing && existing.rol !== "super_admin") {
    throw new Error(
      `Ya existe un usuario '${email}' con rol '${existing.rol}'. Un super admin no puede ` +
        "pertenecer a un tenant: usá otro email."
    );
  }

  if (existing) {
    await prisma.user.update({
      where: { email },
      data: { passwordHash, estado: "activo" }
    });
    console.log(`Super admin '${email}' ya existía — contraseña actualizada y estado activo.`);
  } else {
    // tenantId null: lo exige el check constraint de la migración 0001.
    await prisma.user.create({
      data: { nombre, email, passwordHash, rol: "super_admin", tenantId: null, estado: "activo" }
    });
    console.log(`Super admin '${email}' creado.`);
  }
  printPassword(email, password, generated);
}

async function setRol(flags: Record<string, string>): Promise<void> {
  const email = normalizeEmail(requireFlag(flags, "email"));
  const rol = requireFlag(flags, "rol");
  if (rol !== "admin" && rol !== "agente") throw new Error("--rol debe ser 'admin' o 'agente'.");

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, rol: true, tenantId: true }
  });
  if (!user) throw new Error(`No existe el usuario '${email}'.`);
  if (user.rol === "super_admin") {
    throw new Error("No se le cambia el rol a un super admin (no pertenece a ningún tenant).");
  }
  if (!user.tenantId) throw new Error(`El usuario '${email}' no tiene tenant asignado.`);

  // Espejo de la protección "último admin" del endpoint PATCH /users/:id.
  if (user.rol === "admin" && rol === "agente") {
    const otros = await prisma.user.count({
      where: { tenantId: user.tenantId, rol: "admin", estado: "activo", id: { not: user.id } }
    });
    if (otros === 0) throw new Error("Dejaría al tenant sin admins activos. Promové a otro primero.");
  }

  await prisma.user.update({ where: { id: user.id }, data: { rol } });
  const slug = (await slugsByTenantId()).get(user.tenantId) ?? user.tenantId;
  console.log(`'${email}' (tenant ${slug}): ${user.rol} → ${rol}`);
}

async function setPassword(flags: Record<string, string>): Promise<void> {
  const email = normalizeEmail(requireFlag(flags, "email"));
  const { password, generated } = resolvePassword(flags);

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`No existe el usuario '${email}'.`);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) }
  });
  // Las sesiones activas siguen vivas: si el motivo es una filtración, cerrá
  // sesión en todos los dispositivos con POST /auth/logout { all: true }.
  console.log(`Contraseña de '${email}' actualizada.`);
  printPassword(email, password, generated);
}

const USAGE = `CLI de administración — back-lamelas

  npm run admin -- list [--tenant <slug>]
  npm run admin -- create-superadmin --email <email> [--nombre "..."] [--password <pass>]
  npm run admin -- set-rol --email <email> --rol admin|agente
  npm run admin -- set-password --email <email> [--password <pass>]
  npm run admin -- zernio-adopt --tenant <slug> --profile <id> --account <id> --mode coexistence

Sin --password se genera una contraseña fuerte y se imprime una sola vez.`;

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "list":
      return list(flags);
    case "create-superadmin":
      return createSuperadmin(flags);
    case "set-rol":
      return setRol(flags);
    case "set-password":
      return setPassword(flags);
    case "zernio-adopt":
      return runZernioAdoptCli(prisma, flags);
    default:
      console.log(USAGE);
      if (cmd) process.exitCode = 1;
  }
}

main()
  .catch((e: unknown) => {
    console.error(`\n✖ ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
