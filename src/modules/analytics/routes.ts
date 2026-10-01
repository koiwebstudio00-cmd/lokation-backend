import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import * as analytics from "./service.js";

export const analyticsRoutes = Router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = z.string().regex(DATE).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= "0100-01-01";
}, "La fecha no es válida.");
const tipos = [
  "monoambiente",
  "departamento",
  "casa",
  "duplex",
  "local_comercial",
  "oficina",
  "galpon",
  "estacionamiento",
  "terreno",
  "otro"
] as const;

const querySchema = z.object({
  from: validDate.optional(),
  to: validDate.optional(),
  timezone: z.string().trim().min(1).max(100).default("America/Argentina/Tucuman"),
  canal: z.enum(["web", "whatsapp", "instagram", "messenger", "manual"]).optional(),
  seller_id: z.string().uuid().optional(),
  operacion: z.enum(["venta", "alquiler", "ambos"]).optional(),
  tipo: z.enum(tipos).optional(),
  zona: z.string().trim().min(1).max(120).optional(),
  clasificacion: z.enum(["potencial", "fantasma"]).optional()
});

function isoDateInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function lastDayOfMonth(year: number, month: number) {
  // month 1–12; el día 0 del mes siguiente es el último de este.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Período contra el que se comparan los KPIs. Si el rango es un mes calendario
// completo (1 al último día), se compara con el mes calendario anterior — es
// lo que espera un reporte mensual (septiembre vs. agosto, aunque tengan
// distinta cantidad de días). Si no, con la misma cantidad de días
// inmediatamente antes.
export function previousPeriod(from: string, to: string, days: number) {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  if (fy === ty && fm === tm && fd === 1 && td === lastDayOfMonth(ty, tm)) {
    const py = fm === 1 ? fy - 1 : fy;
    const pm = fm === 1 ? 12 : fm - 1;
    const mm = String(pm).padStart(2, "0");
    return { from: `${py}-${mm}-01`, to: `${py}-${mm}-${lastDayOfMonth(py, pm)}` };
  }
  const prevTo = shiftDate(from, -1);
  return { from: shiftDate(prevTo, -(days - 1)), to: prevTo };
}

function parseFilters(query: unknown): analytics.AnalyticsFilters {
  const parsed = querySchema.parse(query);
  try {
    new Intl.DateTimeFormat("es-AR", { timeZone: parsed.timezone }).format();
  } catch {
    throw new z.ZodError([
      { code: "custom", path: ["timezone"], message: "La zona horaria no es válida." }
    ]);
  }

  const today = isoDateInTimezone(new Date(), parsed.timezone);
  const to = parsed.to ?? today;
  const from = parsed.from ?? shiftDate(to, -29);
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T00:00:00.000Z`);
  const days = Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1;

  if (!Number.isFinite(days) || days < 1 || days > 366) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["from"],
        message: "El período debe tener entre 1 y 366 días y finalizar después de su inicio."
      }
    ]);
  }

  return {
    from,
    to,
    timezone: parsed.timezone,
    canal: parsed.canal,
    sellerId: parsed.seller_id,
    operacion: parsed.operacion,
    tipo: parsed.tipo,
    zona: parsed.zona,
    clasificacion: parsed.clasificacion,
    previous: previousPeriod(from, to, days)
  };
}

analyticsRoutes.use("/analytics", requireAuth, requireRole("admin"));

analyticsRoutes.get("/analytics/overview", async (req, res) => {
  res.json(await analytics.overview(req.auth!, parseFilters(req.query)));
});

analyticsRoutes.get("/analytics/leads", async (req, res) => {
  res.json(await analytics.leads(req.auth!, parseFilters(req.query)));
});

analyticsRoutes.get("/analytics/sofia", async (req, res) => {
  res.json(await analytics.sofia(req.auth!, parseFilters(req.query)));
});

analyticsRoutes.get("/analytics/properties", async (req, res) => {
  res.json(await analytics.properties(req.auth!, parseFilters(req.query)));
});
