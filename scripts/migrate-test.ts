// Aplica las migraciones a la BD de test (DATABASE_URL_TEST, rol privilegiado).
// Uso: npm run test:prepare
import "dotenv/config";
import { execSync } from "node:child_process";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("Falta DATABASE_URL_TEST en .env");

execSync("npx prisma migrate deploy", {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url }
});
