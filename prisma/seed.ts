// Seed local de Ubikka: operador y dos inmobiliarias aisladas.
// Corre con el rol privilegiado: DATABASE_URL_MIGRATE (bypassa RLS a propósito).
// Uso: npm run seed
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

if (process.env.NODE_ENV === "production") {
  throw new Error("El seed de demostración no puede ejecutarse en producción.");
}

const url = process.env.DATABASE_URL_MIGRATE;
if (!url) throw new Error("Falta DATABASE_URL_MIGRATE en .env");

const prisma = new PrismaClient({ datasources: { db: { url } } });

// Credenciales SOLO de desarrollo.
const DEV_PASSWORD = "password123";

async function main() {
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 12);

  const tenants = await Promise.all([
    prisma.tenant.upsert({
      where: { slug: "demo-a" },
      update: { nombre: "Inmobiliaria Demo A" },
      create: { nombre: "Inmobiliaria Demo A", slug: "demo-a" }
    }),
    prisma.tenant.upsert({
      where: { slug: "demo-b" },
      update: { nombre: "Inmobiliaria Demo B" },
      create: { nombre: "Inmobiliaria Demo B", slug: "demo-b" }
    })
  ]);

  const users = [
    { nombre: "Operador Ubikka", email: "operador@ubikka.test", rol: "super_admin" as const, tenantId: null },
    ...tenants.flatMap((tenant, index) => {
      const suffix = index === 0 ? "a" : "b";
      return [
        { nombre: `Admin Demo ${suffix.toUpperCase()}`, email: `admin@demo-${suffix}.test`, rol: "admin" as const, tenantId: tenant.id },
        { nombre: `Agente Demo ${suffix.toUpperCase()}`, email: `agente@demo-${suffix}.test`, rol: "agente" as const, tenantId: tenant.id }
      ];
    })
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { passwordHash },
      create: { ...u, passwordHash }
    });
  }

  for (const [index, tenant] of tenants.entries()) {
    const suffix = index === 0 ? "a" : "b";
    const agent = users.find((user) => user.email === `agente@demo-${suffix}.test`)!;
    await prisma.property.upsert({
      where: { slug: `venta-casa-demo-${suffix}` },
      update: {},
      create: {
        tenantId: tenant.id,
        userId: (await prisma.user.findUniqueOrThrow({ where: { email: agent.email } })).id,
        titulo: `Casa de prueba ${suffix.toUpperCase()}`,
        operacion: "venta",
        tipo: "casa",
        precio: index === 0 ? 90000 : 120000,
        moneda: "USD",
        ciudad: "Ciudad de prueba",
        slug: `venta-casa-demo-${suffix}`
      }
    });
  }

  console.log("Seed local Ubikka OK: operador@ubikka.test y usuarios admin/agente en demo-a.test y demo-b.test.");
  console.log(`Contraseña local de demostración: ${DEV_PASSWORD}`);
}

main().finally(() => prisma.$disconnect());
