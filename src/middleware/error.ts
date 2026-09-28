import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { ApiError } from "../lib/errors.js";

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: "El recurso no existe." }
  });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details }
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Datos inválidos.",
        details: err.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message
        }))
      }
    });
    return;
  }

  // Nunca filtrar detalles internos.
  console.error(err);
  res.status(500).json({
    error: { code: "INTERNAL", message: "Error interno del servidor." }
  });
}
