import { Prisma } from "@prisma/client";
import type { Tx } from "../../lib/prisma.js";

export const CHANNEL_ACCOUNT_SELECT = {
  id: true,
  canal: true,
  displayName: true,
  displayPhone: true,
  estado: true,
  connectionMode: true,
  disconnectedAt: true,
  conectadaPor: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.ChannelAccountSelect;

export function findChannelsByTenant(tx: Tx) {
  return tx.channelAccount.findMany({
    select: CHANNEL_ACCOUNT_SELECT,
    orderBy: { createdAt: "desc" }
  });
}

export function findChannelById(tx: Tx, id: string) {
  return tx.channelAccount.findUnique({ where: { id }, select: CHANNEL_ACCOUNT_SELECT });
}

/** Incluye zernioAccountId — hace falta para llamar a la API de Zernio (health, disconnect). */
export function findChannelWithZernioId(tx: Tx, id: string) {
  return tx.channelAccount.findUnique({
    where: { id },
    select: { ...CHANNEL_ACCOUNT_SELECT, zernioAccountId: true, tenantId: true }
  });
}

/**
 * La cuenta activa del canal en el tenant del contexto, si hay. La base ya lo
 * impide con un índice parcial único; esto existe para poder avisar con un
 * mensaje claro ANTES de que Postgres tire el error, que llegaría al panel
 * como un 500 sin explicación.
 */
export function findActivaPorCanal(tx: Tx, canal: string) {
  return tx.channelAccount.findFirst({
    where: { canal, estado: "activa" },
    select: { id: true, zernioAccountId: true, displayPhone: true }
  });
}

export function findByZernioAccountId(tx: Tx, zernioAccountId: string) {
  return tx.channelAccount.findUnique({ where: { zernioAccountId } });
}

export function insertChannel(
  tx: Tx,
  data: {
    tenantId: string;
    canal: string;
    zernioProfileId: string;
    zernioAccountId: string;
    displayName?: string | null;
    displayPhone?: string | null;
    conectadaPor: string;
  }
) {
  return tx.channelAccount.create({ data, select: CHANNEL_ACCOUNT_SELECT });
}

/** Reconexión de una cuenta que ya existía (desconectada/error → activa). */
export function reactivarChannel(
  tx: Tx,
  id: string,
  data: { displayName?: string | null; displayPhone?: string | null; conectadaPor: string }
) {
  return tx.channelAccount.update({
    where: { id },
    data: { ...data, estado: "activa", disconnectedAt: null },
    select: CHANNEL_ACCOUNT_SELECT
  });
}

export function marcarDesconectado(tx: Tx, id: string) {
  return tx.channelAccount.updateMany({
    where: { id },
    data: { estado: "desconectada", disconnectedAt: new Date() }
  });
}

/**
 * El join que hace el worker de webhooks: accountId de Zernio → tenant. Corre
 * con contexto 'worker' (policy channel_accounts_worker_select), nunca con el
 * tenant del request porque acá todavía no hay uno.
 */
export function findTenantByZernioAccountId(tx: Tx, zernioAccountId: string) {
  return tx.channelAccount.findFirst({
    where: { zernioAccountId, estado: "activa" },
    select: { id: true, tenantId: true, canal: true, zernioAccountId: true }
  });
}
