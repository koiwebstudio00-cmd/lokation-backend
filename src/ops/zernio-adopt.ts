// Entry point operativo compilado dentro de la imagen de producción. No abre
// puertos ni se importa desde la API: sólo corre cuando un operador lo invoca.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { runZernioAdoptCli } from "../modules/integrations/channel-adoption.cli.js";

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (!argument.startsWith("--")) continue;
    const raw = argument.slice(2);
    const equalsAt = raw.indexOf("=");
    const name = equalsAt >= 0 ? raw.slice(0, equalsAt) : raw;
    if (!name) continue;
    if (equalsAt >= 0) {
      flags[name] = raw.slice(equalsAt + 1);
      continue;
    }
    const next = argv[i + 1];
    flags[name] = next && !next.startsWith("--") ? (i++, next) : "true";
  }
  return flags;
}

const url = process.env.DATABASE_URL_MIGRATE;
if (!url) throw new Error("Falta DATABASE_URL_MIGRATE.");

const prisma = new PrismaClient({ datasources: { db: { url } } });

runZernioAdoptCli(prisma, parseFlags(process.argv.slice(2)))
  .catch((error: unknown) => {
    console.error(`\n✖ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
