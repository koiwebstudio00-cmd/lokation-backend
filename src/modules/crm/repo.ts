import type { Prisma } from "@prisma/client";
import type { Tx } from "../../lib/prisma.js";

const TAKE_INCLUDE = {
  property: { select: { id: true, titulo: true, operacion: true, precio: true } },
  assignee: { select: { id: true, nombre: true } },
  takenBy: { select: { id: true, nombre: true } },
  notes: {
    orderBy: { createdAt: "desc" as const },
    include: { user: { select: { id: true, nombre: true } } }
  }
} satisfies Prisma.LeadInclude;

/**
 * Serializa tomas concurrentes sobre el mismo lead. La query vive en repo
 * porque el bloqueo FOR UPDATE no se puede expresar con la API tipada de Prisma.
 * RLS sigue aplicando: una fila no visible se comporta como inexistente.
 */
export async function lockLeadForTake(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    select id from leads where id = ${id}::uuid for update
  `;
  if (rows.length === 0) return null;
  return tx.lead.findUnique({ where: { id }, include: TAKE_INCLUDE });
}

export function markLeadTaken(
  tx: Tx,
  id: string,
  data: { tomadoAt: Date; tomadoPor: string; tomadoOrigen: "panel"; assignedTo?: string }
) {
  return tx.lead.updateMany({
    where: { id, tomadoAt: null },
    data
  });
}

export function findLeadAfterTake(tx: Tx, id: string) {
  return tx.lead.findUnique({ where: { id }, include: TAKE_INCLUDE });
}

export function findActiveConversation(tx: Tx, leadId: string) {
  return tx.conversation.findFirst({
    where: { leadId, estado: { not: "cerrada" } },
    orderBy: { createdAt: "desc" },
    select: { id: true }
  });
}

export function markConversationHuman(tx: Tx, id: string, vendedorId: string) {
  return tx.conversation.updateMany({
    where: { id, estado: { not: "cerrada" } },
    data: {
      estado: "humano",
      vendedorId,
      followupStep: 0,
      followupDueAt: null,
      followupClaimedAt: null
    }
  });
}

export function silenceConversationForManualGhost(tx: Tx, leadId: string) {
  return tx.conversation.updateMany({
    where: { leadId, estado: { not: "cerrada" } },
    data: {
      estado: "humano",
      followupStep: 0,
      followupDueAt: null,
      followupClaimedAt: null
    }
  });
}

export function findPendingHandoff(tx: Tx, conversationId: string) {
  return tx.handoff.findFirst({
    where: { conversationId, resultado: "pendiente" },
    orderBy: { asignadoAt: "desc" },
    select: { id: true }
  });
}

export function closeHandoffAsTaken(tx: Tx, id: string, tomadoAt: Date) {
  return tx.handoff.updateMany({
    where: { id, resultado: "pendiente" },
    data: { resultado: "tomado", tomadoAt }
  });
}
