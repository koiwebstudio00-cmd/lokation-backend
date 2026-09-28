// Seed de desarrollo: super admin Koi + tenant demo con admin y agente.
// Corre con el rol privilegiado: DATABASE_URL_MIGRATE (bypassa RLS a propósito).
// Uso: npm run seed
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const url = process.env.DATABASE_URL_MIGRATE;
if (!url) throw new Error("Falta DATABASE_URL_MIGRATE en .env");

const prisma = new PrismaClient({ datasources: { db: { url } } });

// Credenciales SOLO de desarrollo.
const DEV_PASSWORD = "password123";

async function main() {
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 12);

  const demo = await prisma.tenant.upsert({
    where: { slug: "demo" },
    update: {},
    create: { nombre: "Inmobiliaria Demo", slug: "demo" }
  });

  for (const u of [
    { nombre: "Super Admin Koi", email: "super@koistudio.dev", rol: "super_admin" as const, tenantId: null },
    { nombre: "Admin Demo", email: "admin@demo.dev", rol: "admin" as const, tenantId: demo.id },
    { nombre: "Agente Demo", email: "agente@demo.dev", rol: "agente" as const, tenantId: demo.id }
  ]) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { passwordHash },
      create: { ...u, passwordHash }
    });
  }

  console.log(`Seed OK — usuarios dev (password: ${DEV_PASSWORD}):`);
  console.log("  super@koistudio.dev (super_admin)");
  console.log("  admin@demo.dev (admin, tenant demo)");
  console.log("  agente@demo.dev (agente, tenant demo)");
}

main().finally(() => prisma.$disconnect());
