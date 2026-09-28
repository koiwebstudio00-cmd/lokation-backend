import { Prisma } from "@prisma/client";
import type { Tx } from "../../lib/prisma.js";

export const FOLLOWUP_SELECT = {
  id: true,
  tenantId: true,
  leadId: true,
  channelAccountId: true,
  providerConversationId: true,
  estado: true,
  followupStep: true,
  followupDueAt: true,
  followupClaimedAt: true,
  lastLeadMessageAt: true
} satisfies Prisma.ConversationSelect;

export function listDue(tx: Tx, now: Date, leaseExpiredAt: Date) {
  return tx.conversation.findMany({
    where: {
      canal: "whatsapp",
      estado: "bot",
      followupStep: { in: [1, 2, 3] },
      followupDueAt: { lte: now },
      OR: [
        { followupClaimedAt: null },
        { followupClaimedAt: { lte: leaseExpiredAt } }
      ],
      channelAccountId: { not: null },
      providerConversationId: { not: null }
    },
    select: FOLLOWUP_SELECT,
    orderBy: { followupDueAt: "asc" },
    take: 100
  });
}

export async function claim(
  tx: Tx,
  conversationId: string,
  step: number,
  now: Date,
  leaseExpiredAt: Date
) {
  const claimed = await tx.conversation.updateMany({
    where: {
      id: conversationId,
      estado: "bot",
      followupStep: step,
      followupDueAt: { lte: now },
      OR: [
        { followupClaimedAt: null },
        { followupClaimedAt: { lte: leaseExpiredAt } }
      ]
    },
    data: { followupClaimedAt: now }
  });
  if (claimed.count === 0) return null;
  return tx.conversation.findUnique({
    where: { id: conversationId },
    select: FOLLOWUP_SELECT
  });
}

export function cancel(tx: Tx, conversationId: string, claimedAt?: Date) {
  return tx.conversation.updateMany({
    where: {
      id: conversationId,
      ...(claimedAt ? { followupClaimedAt: claimedAt } : {})
    },
    data: {
      followupStep: 0,
      followupDueAt: null,
      followupClaimedAt: null
    }
  });
}

export function retryLater(tx: Tx, conversationId: string, claimedAt: Date, dueAt: Date) {
  return tx.conversation.updateMany({
    where: { id: conversationId, estado: "bot", followupClaimedAt: claimedAt },
    data: { followupDueAt: dueAt, followupClaimedAt: null }
  });
}

export function promoteToFinal(tx: Tx, conversationId: string, claimedAt: Date, dueAt: Date) {
  return tx.conversation.updateMany({
    where: { id: conversationId, estado: "bot", followupClaimedAt: claimedAt },
    data: { followupStep: 3, followupDueAt: dueAt, followupClaimedAt: null }
  });
}

export async function isClaimActive(
  tx: Tx,
  conversationId: string,
  step: number,
  claimedAt: Date
) {
  const conversation = await tx.conversation.findFirst({
    where: {
      id: conversationId,
      estado: "bot",
      followupStep: step,
      followupClaimedAt: claimedAt
    },
    select: { id: true }
  });
  return Boolean(conversation);
}

export async function completeMessage(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    claimedAt: Date;
    currentStep: 1 | 2;
    nextDueAt: Date;
    content: string;
    providerMessageId?: string | null;
  }
) {
  const advanced = await tx.conversation.updateMany({
    where: {
      id: input.conversationId,
      estado: "bot",
      followupStep: input.currentStep,
      followupClaimedAt: input.claimedAt
    },
    data: {
      followupStep: input.currentStep + 1,
      followupDueAt: input.nextDueAt,
      followupClaimedAt: null
    }
  });
  if (advanced.count === 0) return false;

  await tx.conversationMessage.create({
    data: {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      rol: "agente_ia",
      tipo: "texto",
      contenido: input.content,
      providerMessageId: input.providerMessageId ?? null,
      meta: {
        automatic_followup: true,
        followup_step: input.currentStep
      }
    }
  });
  return true;
}

export async function lock(tx: Tx, conversationId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    select id from conversations where id = ${conversationId}::uuid for update
  `;
  return rows.length > 0;
}
