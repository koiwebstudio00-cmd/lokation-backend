import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { seedClients } from "../prisma/seed-clients.js";
const url = process.env.DATABASE_URL_MIGRATE;
if (!url || process.env.NODE_ENV === "production") throw new Error("Solo desarrollo local.");
const target = new URL(url);
if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.port !== "5433" || target.pathname !== "/ubikka_dev") throw new Error("Solo ubikka_dev local.");
const db = new PrismaClient({ datasources: { db: { url } } });
try {
  for (const suffix of ["a", "b"]) {
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: `demo-${suffix}` } });
    const admin = await db.user.findFirstOrThrow({ where: { tenantId: tenant.id, rol: "admin" } });
    await seedClients(db, tenant.id, admin.id, suffix);
    const people = await db.rentalPerson.findMany({ where: { tenantId: tenant.id, email: { in: [`comprador@clientes-demo-${suffix}.test`, `vendedor@clientes-demo-${suffix}.test`] } } });
    const operations = await db.clientOperation.count({ where: { tenantId: tenant.id, personId: { in: people.map((p) => p.id) }, lead: { canalRef: `seed-client-sale-${suffix}` } } });
    if (people.length !== 2 || operations !== 2) throw new Error(`Fixtures de Clientes inválidas en demo-${suffix}`);
    console.log(`Clientes comerciales y operación vinculada: demo-${suffix}`);
  }
} finally { await db.$disconnect(); }
