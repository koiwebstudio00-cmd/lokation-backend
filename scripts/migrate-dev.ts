// Aplica las migraciones a la BD de desarrollo con el rol DUEÑO
// (DATABASE_URL_MIGRATE). `prisma migrate deploy` a secas usa DATABASE_URL, que
// en local es app_rt (sin privilegios): no puede crear policies sobre tablas
// que no creó (p. ej. `refresh_admin_revoke` sobre refresh_tokens) y falla con
// "must be owner of table". Uso: npm run db:migrate:deploy
import "dotenv/config";
import { execSync } from "node:child_process";

const url = process.env.DATABASE_URL_MIGRATE;
if (!url) throw new Error("Falta DATABASE_URL_MIGRATE en .env");

execSync("npx prisma migrate deploy", {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url }
});
