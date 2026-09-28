import { Prisma } from "@prisma/client";
import type { Tx } from "../../lib/prisma.js";

const PROVIDER_CONVERSATION_SELECT = {
  id: true,
  tenantId: true,
  leadId: true,
  estado: true,
  channelAccountId: true,
  providerConversationId: true
} satisfies Prisma.ConversationSelect;

export function findProviderConversation(
  tx: Tx,
  channelAccountId: string,
  providerConversationId: string
) {
  return tx.conversation.findFirst({
    where: { channelAccountId, providerConversationId, estado: { not: "cerrada" } },
    select: PROVIDER_CONVERSATION_SELECT
  });
}

export function findLegacyWhatsappConversation(tx: Tx, tenantId: string, canalRef: string) {
  return tx.conversation.findFirst({
    where: {
      tenantId,
      canal: "whatsapp",
      canalRef,
      channelAccountId: null,
      providerConversationId: null,
      estado: { not: "cerrada" }
    },
    select: PROVIDER_CONVERSATION_SELECT
  });
}

export function attachProviderIdentity(
  tx: Tx,
  conversationId: string,
  channelAccountId: string,
  providerConversationId: string
) {
  return tx.conversation.update({
    where: { id: conversationId },
    data: { channelAccountId, providerConversationId },
    select: PROVIDER_CONVERSATION_SELECT
  });
}

export function insertExternalMessage(
  tx: Tx,
  data: {
    tenantId: string;
    conversationId: string;
    contenido: string;
    tipo: "texto" | "audio" | "imagen" | "documento";
    mediaUrl: string | null;
    providerMessageId: string;
    meta: Record<string, unknown>;
  }
) {
  return tx.conversationMessage.createMany({
    data: [{ ...data, rol: "vendedor", meta: data.meta as Prisma.InputJsonValue }],
    skipDuplicates: true
  });
}

export function markConversationHuman(tx: Tx, conversationId: string) {
  return tx.conversation.updateMany({
    where: { id: conversationId, estado: { not: "cerrada" } },
    data: {
      estado: "humano",
      followupStep: 0,
      followupDueAt: null,
      followupClaimedAt: null
    }
  });
}

export function markLeadTakenFromBusinessApp(tx: Tx, leadId: string, tomadoAt: Date) {
  return tx.lead.updateMany({
    where: { id: leadId, tomadoAt: null },
    data: { tomadoAt, tomadoPor: null, tomadoOrigen: "whatsapp_business_app" }
  });
}

export function findLeadForEvent(tx: Tx, leadId: string) {
  return tx.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      tenantId: true,
      propertyId: true,
      assignedTo: true,
      canal: true,
      nombre: true,
      email: true,
      telefono: true,
      mensaje: true,
      estado: true,
      tomadoAt: true,
      tomadoPor: true,
      tomadoOrigen: true
    }
  });
}

export function closePendingHandoff(tx: Tx, conversationId: string, tomadoAt: Date) {
  return tx.handoff.updateMany({
    where: { conversationId, resultado: "pendiente" },
    data: { resultado: "tomado", tomadoAt }
  });
}
