// Conexión de canales de mensajería vía Zernio — hoy solo WhatsApp. Ver
// lamelas-agent/docs/plan-implementacion-zernio.md §4.
//
// Todo corre con la sesión del admin (contexto normal de RLS): no hay API key
// de por medio acá, es gestión del panel, igual que las API keys de
// integrations/service.ts.
import { config } from "../../config.js";
import { ApiError } from "../../lib/errors.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import type { AccessClaims } from "../../lib/tokens.js";
import { ZernioApiError, zernioFetch } from "../../lib/zernio.js";
import * as repo from "./channels.repo.js";

const ctxOf = (a: AccessClaims) => ({
  userId: a.userId,
  tenantId: a.tenantId,
  rol: a.rol
});

/** Canales soportados en este ciclo. Instagram queda para más adelante (regla 10). */
export const CHANNEL_CANALES = ["whatsapp"] as const;
export type ChannelCanal = (typeof CHANNEL_CANALES)[number];

/**
 * `SocialAccount` de Zernio, recortado a lo que usamos. La clave es `_id`: es
 * el mismo valor que después llega en `account.accountId` de los webhooks, y
 * por lo tanto el que guardamos en `channel_accounts.zernio_account_id`.
 * En WhatsApp, `username` es el número en E.164.
 */
interface ZernioAccount {
  _id: string;
  platform: string;
  username?: string;
  displayName?: string;
  isActive?: boolean;
}

interface ZernioProfile {
  _id: string;
  name?: string;
}

interface ZernioProfileCreateResponse {
  profile?: ZernioProfile;
  // Compatibilidad con respuestas antiguas que devolvían el profile plano.
  _id?: string;
}

interface ZernioAccountHealth {
  status?: string;
  issues?: string[];
  platformConnection?: { status?: string };
  [key: string]: unknown;
}

function channelPayload(c: {
  id: string;
  canal: string;
  displayName: string | null;
  displayPhone: string | null;
  estado: string;
  connectionMode: string;
  disconnectedAt: Date | null;
  conectadaPor: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: c.id,
    canal: c.canal,
    display_name: c.displayName,
    display_phone: c.displayPhone,
    estado: c.estado,
    connection_mode: c.connectionMode,
    disconnected_at: c.disconnectedAt,
    conectada_por: c.conectadaPor,
    creada_at: c.createdAt,
    actualizada_at: c.updatedAt
  };
}

export async function listChannels(auth: AccessClaims) {
  const data = await runWithContext(ctxOf(auth), (tx) => repo.findChannelsByTenant(tx));
  return { data: data.map(channelPayload) };
}

/** Crea el profile de Zernio del tenant la primera vez que hace falta (lazy, 1:1). */
async function ensureZernioProfile(tx: Tx, tenantId: string): Promise<string> {
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, slug: true, zernioProfileId: true }
  });
  if (!tenant) throw new ApiError("NOT_FOUND", "El recurso no existe.");
  if (tenant.zernioProfileId) return tenant.zernioProfileId;

  let profileId: string | undefined;

  try {
    const created = await zernioFetch<ZernioProfileCreateResponse>("/profiles", {
      method: "POST",
      body: { name: tenant.slug },
      headers: { "Idempotency-Key": `koi-tenant-${tenant.id}-profile-v1` }
    });
    profileId = created.profile?._id ?? created._id;
  } catch (err) {
    if (err instanceof ZernioApiError && err.zernioCode === "profile_name_conflict") {
      const existingId = err.zernioDetails?.existingProfileId;
      if (typeof existingId === "string" && existingId) profileId = existingId;

      // Compatibilidad si una versión de Zernio informa el conflicto sin ID.
      if (!profileId) {
        const { profiles } = await zernioFetch<{ profiles: ZernioProfile[] }>("/profiles", {
          query: { name: tenant.slug }
        });
        profileId = profiles.find((profile) => profile.name === tenant.slug)?._id;
      }
    } else {
      throw err;
    }
  }

  if (!profileId) {
    throw new ApiError("INTERNAL", "Zernio no devolvió el identificador del profile.");
  }

  await tx.tenant.update({ where: { id: tenantId }, data: { zernioProfileId: profileId } });
  return profileId;
}

/** `GET /v1/integrations/channels/:canal/connect-url` — arma la URL de OAuth de Zernio. */
export async function getConnectUrl(auth: AccessClaims, canal: ChannelCanal) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const profileId = await ensureZernioProfile(tx, auth.tenantId!);
    // Tiene que coincidir con la ruta real del panel:
    // lamelas/src/app/(app)/(admin)/whatsapp/conectar/callback/page.tsx
    // Zernio agrega connected/profileId/accountId/username al finalizar. Se
    // evita un query preexistente para que el redirect de Meta no pierda ni
    // mezcle nuestros parámetros con los suyos.
    const redirectUrl = `${config.ZERNIO_REDIRECT_BASE_URL.replace(/\/$/, "")}/whatsapp/conectar/callback`;

    const query: Record<string, string> = { profileId, redirect_url: redirectUrl };
    // Número nuevo, sin WABA previo: Embedded Signup completo (verificación de
    // negocio incluida), no el selector de coexistencia. Ver plan §4.5.
    if (canal === "whatsapp") query.onboarding = "api";

    const res = await zernioFetch<{ authUrl: string; state: string }>(
      `/connect/${canal}`,
      { query }
    );
    return { auth_url: res.authUrl };
  });
}

/**
 * `GET /v1/integrations/channels/callback` — el panel llama a esto al volver
 * del redirect. No confía en los query params del redirect para la identidad
 * de la cuenta (podrían venir manipulados): vuelve a pedirle a Zernio el
 * estado real de las cuentas del profile y toma la primera activa del canal.
 */
// El envelope (`{ accounts }`) y el shape de `SocialAccount` salen de la
// referencia de la API de Zernio. Lo único que queda por confirmar contra la
// API real es el caso de MÁS DE UNA cuenta activa de WhatsApp en el mismo
// profile: la doc no documenta el orden de `accounts`, así que abajo se toma
// la primera activa. Con un solo número —el caso de Lamelas, y lo único que
// el índice parcial de `channel_accounts` permite tener activo— es indistinto.
export async function completeConnection(
  auth: AccessClaims,
  canal: ChannelCanal,
  accountId?: string
) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { id: auth.tenantId! },
      select: { zernioProfileId: true }
    });
    if (!tenant?.zernioProfileId) {
      throw new ApiError("CONFLICT", "Todavía no se inició la conexión de ningún canal.");
    }

    const { accounts } = await zernioFetch<{ accounts: ZernioAccount[] }>("/accounts", {
      query: { profileId: tenant.zernioProfileId, platform: canal }
    });
    const cuenta = accountId
      ? accounts?.find((a) => a._id === accountId && a.isActive !== false)
      : accounts?.find((a) => a.isActive !== false);
    if (!cuenta) {
      throw new ApiError(
        "CONFLICT",
        "Zernio no encontró ninguna cuenta conectada todavía. Probá de nuevo en unos segundos."
      );
    }

    const zernioAccountId = cuenta._id;

    // Un solo número activo por tenant y canal. Es la misma regla que impone el
    // índice parcial de la migración 0018; acá se chequea antes para poder
    // explicarla, en vez de que Postgres tire un P2002 que el errorHandler
    // convierte en un 500 mudo. Reconectar el MISMO número sí se permite: eso
    // no es un segundo canal, es recuperar el que ya estaba.
    const activa = await repo.findActivaPorCanal(tx, canal);
    if (activa && activa.zernioAccountId !== zernioAccountId) {
      throw new ApiError(
        "CONFLICT",
        `Ya hay un número de WhatsApp conectado (${activa.displayPhone ?? "sin número visible"}). Desconectalo antes de conectar otro.`
      );
    }

    const existente = await repo.findByZernioAccountId(tx, zernioAccountId);
    const snapshot = { displayName: cuenta.displayName ?? null, displayPhone: cuenta.username ?? null };

    const channel = existente
      ? await repo.reactivarChannel(tx, existente.id, { ...snapshot, conectadaPor: auth.userId })
      : await repo.insertChannel(tx, {
          tenantId: auth.tenantId!,
          canal,
          zernioProfileId: tenant.zernioProfileId,
          zernioAccountId,
          ...snapshot,
          conectadaPor: auth.userId
        });

    return { channel: channelPayload(channel) };
  });
}

export async function disconnectChannel(auth: AccessClaims, id: string) {
  await runWithContext(ctxOf(auth), async (tx) => {
    const channel = await repo.findChannelWithZernioId(tx, id);
    if (!channel) throw new ApiError("NOT_FOUND", "El recurso no existe.");

    // La cuenta local solo cambia cuando Zernio confirma la baja. Un 404 es
    // equivalente a éxito (ya estaba desconectada); ante timeout/5xx se conserva
    // activa para que el admin pueda reintentar sin divergir entre sistemas.
    try {
      await zernioFetch(`/accounts/${channel.zernioAccountId}`, { method: "DELETE" });
    } catch (err) {
      if (!(err instanceof ZernioApiError && err.code === "NOT_FOUND")) throw err;
    }

    const { count } = await repo.marcarDesconectado(tx, id);
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
  });
}

export async function getChannelHealth(auth: AccessClaims, id: string) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const channel = await repo.findChannelWithZernioId(tx, id);
    if (!channel) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    if (channel.estado !== "activa") {
      throw new ApiError("CONFLICT", "El número está desconectado.");
    }

    const health = await zernioFetch<ZernioAccountHealth>(
      `/accounts/${channel.zernioAccountId}/health`
    );
    if (
      health.status !== "healthy" ||
      health.platformConnection?.status !== "connected"
    ) {
      throw new ApiError("CONFLICT", "Zernio informa que el número no está operativo.");
    }
    return health;
  });
}
