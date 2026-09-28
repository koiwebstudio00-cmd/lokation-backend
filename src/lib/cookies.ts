import type { Response } from "express";
import { config } from "../config.js";
import { REFRESH_TTL_DAYS } from "./tokens.js";

export const ACCESS_COOKIE = "access_token";
export const REFRESH_COOKIE = "refresh_token";
export const CSRF_COOKIE = "csrf_token";

// sameSite y domain salen de config: si el panel y la API viven en sitios
// distintos hace falta 'none', y si viven en subdominios del mismo dominio
// conviene fijar el domain. Ver docs/plan-despliegue-vps.md.
const base = {
  httpOnly: true,
  secure: config.COOKIE_SECURE,
  sameSite: config.COOKIE_SAMESITE,
  ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {})
};

export function setAuthCookies(
  res: Response,
  tokens: { access: string; refresh: string; csrf: string }
) {
  res.cookie(ACCESS_COOKIE, tokens.access, {
    ...base,
    path: "/",
    maxAge: 15 * 60 * 1000
  });
  // El refresh solo viaja a los endpoints de auth.
  res.cookie(REFRESH_COOKIE, tokens.refresh, {
    ...base,
    path: "/v1/auth",
    maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000
  });
  // CSRF double-submit: legible por JS (NO httpOnly) para reenviarlo como header.
  res.cookie(CSRF_COOKIE, tokens.csrf, {
    ...base,
    httpOnly: false,
    path: "/",
    maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000
  });
}

export function clearAuthCookies(res: Response) {
  // Mismo domain/sameSite que al setearlas: si no coinciden, el navegador no
  // las borra y el logout deja la sesión viva.
  const opts = { ...base, httpOnly: false as boolean };
  res.clearCookie(ACCESS_COOKIE, { ...opts, path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...opts, path: "/v1/auth" });
  res.clearCookie(CSRF_COOKIE, { ...opts, path: "/" });
}
