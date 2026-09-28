import type { Request, Response } from "express";
import morgan from "morgan";
import { config } from "../config.js";

// El health check lo pega el monitoreo cada pocos segundos: si se loguea, en
// producción tapa todas las demás líneas.
const SILENCED_PATHS = new Set(["/v1/health"]);

// morgan evalúa `skip` recién cuando la respuesta termina, y para ese momento
// Express 5 dejó req.url reescrito con la ruta relativa al router ("/health"),
// así que hay que comparar contra originalUrl.
export function shouldSkipLog(originalUrl: string): boolean {
  const path = originalUrl.split("?")[0] ?? originalUrl;
  return SILENCED_PATHS.has(path);
}

/**
 * Log de una línea por request recibida.
 * - dev: formato "dev" de morgan (corto y coloreado, cómodo en la terminal).
 * - producción: formato "combined" (Apache), parseable por agregadores de logs.
 * - test: sin salida, para no ensuciar la corrida de vitest.
 *
 * No loguea headers ni body: el X-Api-Key de export, las cookies de sesión y
 * los tokens de invitación/reset viajan fuera de la línea de log (regla 7).
 */
export function requestLogger() {
  const format = config.NODE_ENV === "production" ? "combined" : "dev";

  return morgan<Request, Response>(format, {
    skip: (req) => config.NODE_ENV === "test" || shouldSkipLog(req.originalUrl)
  });
}
