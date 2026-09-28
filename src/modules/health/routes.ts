import { Router } from "express";
import { getPrisma } from "../../lib/prisma.js";

export const healthRoutes = Router();

healthRoutes.get("/health", async (_req, res) => {
  let db: "up" | "down" = "down";
  try {
    await getPrisma().$queryRaw`select 1`;
    db = "up";
  } catch {
    // BD caída o cliente sin generar: el endpoint responde igual para el monitoreo.
  }
  res.status(db === "up" ? 200 : 503).json({ ok: db === "up", db });
});
