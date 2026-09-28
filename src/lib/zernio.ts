// Cliente delgado sobre la API de Zernio (https://zernio.com/api/v1). Una sola
// API key para todo el team — nunca se expone al panel ni se loggea (regla 7).
// Ver lamelas-agent/docs/plan-implementacion-zernio.md.
import { config } from "../config.js";
import { ApiError, type ErrorCode } from "./errors.js";

const BASE_URL = "https://zernio.com/api/v1";

// Traduce el status HTTP de Zernio a nuestro ErrorCode uniforme (api-spec.md
// §2). No hay un mapeo 1:1 perfecto (Zernio no distingue 402 en nuestro set),
// así que los casos de billing/plan caen en CONFLICT: no es "el request está
// mal", es "la cuenta de Zernio no puede hacer esto ahora".
const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  402: "CONFLICT",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "LIMIT_EXCEEDED",
  429: "RATE_LIMITED"
};

export interface ZernioErrorBody {
  error?: string;
  type?: string;
  code?: string;
  param?: string;
  details?: Record<string, unknown>;
}

/** Conserva el código estable de Zernio para resolver casos recuperables. */
export class ZernioApiError extends ApiError {
  readonly zernioCode?: string;
  readonly zernioDetails?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    zernioCode?: string,
    zernioDetails?: Record<string, unknown>
  ) {
    super(code, message);
    this.zernioCode = zernioCode;
    this.zernioDetails = zernioDetails;
  }
}

/**
 * Falla clara y explícita si falta la key, en vez de mandar `Authorization:
 * Bearer undefined` y que Zernio devuelva un 401 confuso.
 */
function requireApiKey(): string {
  if (!config.ZERNIO_API_KEY) {
    throw new ApiError("INTERNAL", "Falta configurar ZERNIO_API_KEY.");
  }
  return config.ZERNIO_API_KEY;
}

/**
 * GET/POST/DELETE genérico contra Zernio. Nunca deja pasar el error crudo de
 * Zernio al cliente HTTP nuestro: lo traduce a ApiError con el código estable
 * (`type`/`code`) que documenta su API, no el string humano de `error` (que
 * puede cambiar de redacción entre releases de Zernio).
 */
export async function zernioFetch<T>(
  path: string,
  init: {
    method?: string;
    query?: Record<string, string | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<T> {
  const key = requireApiKey();
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      ...init.headers,
      Authorization: `Bearer ${key}`,
      ...(init.body ? { "Content-Type": "application/json" } : {})
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000)
  });

  if (!res.ok) {
    let body: ZernioErrorBody = {};
    try {
      body = (await res.json()) as ZernioErrorBody;
    } catch {
      // Respuesta no-JSON (timeout de gateway, etc.) — sin detalle adicional.
    }
    throw new ZernioApiError(
      STATUS_TO_CODE[res.status] ?? "CONFLICT",
      `Zernio rechazó la solicitud (${body.code ?? res.status}).`,
      body.code,
      body.details
    );
  }

  return res.json() as Promise<T>;
}
