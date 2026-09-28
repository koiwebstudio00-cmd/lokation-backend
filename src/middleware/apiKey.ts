import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/errors.js";
import type { ApiKeyScope } from "../lib/scopes.js";
import { resolveApiKey, type IntegrationContext } from "../modules/integrations/service.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      integration?: IntegrationContext;
    }
  }
}

/**
 * Autentica una integración por header X-Api-Key y exige los scopes indicados.
 *
 *   router.use("/export", requireApiKey("export:read"))
 *
 * La resolución de la key corre con el contexto interno 'export' (solo lookup
 * por hash + last_used_at); los datos se sirven después con el contexto que
 * corresponda, siempre acotado al tenant de la key.
 *
 * El scope es un fail-fast de la capa HTTP: la garantía de aislamiento sigue
 * siendo RLS (regla 1). Una key de otro tenant no ve nada aunque tenga el
 * scope correcto.
 */
export function requireApiKey(...required: ApiKeyScope[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const key = req.get("x-api-key");
    if (!key) throw new ApiError("UNAUTHORIZED", "API key requerida.");

    const integration = await resolveApiKey(key);

    const faltantes = required.filter((scope) => !integration.scopes.includes(scope));
    if (faltantes.length > 0) {
      throw new ApiError(
        "FORBIDDEN",
        `La API key no tiene permiso para esto (falta: ${faltantes.join(", ")}).`
      );
    }

    req.integration = integration;
    next();
  };
}
