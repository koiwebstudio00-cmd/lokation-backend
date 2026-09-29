import { ApiError } from "../../lib/errors.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import { zernioFetch } from "../../lib/zernio.js";
import * as outbound from "./outbound.repo.js";

const FOLLOWUP_DELAY_MS = 2 * 60 * 60 * 1000;

interface SendResult {
  id?: string;
  message?: { id?: string; platformMessageId?: string };
}

export interface DispatchInput {
  tenantId: string;
  conversationId: string;
  operationKey: string;
  content: string;
  handoffId?: string;
}

type SendMessage = (input: {
  accountId: string;
  providerConversationId: string;
  content: string;
  idempotencyKey: string;
}) => Promise<SendResult>;

async function sendThroughZernio(input: Parameters<SendMessage>[0]) {
  return zernioFetch<SendResult>(
    `/inbox/conversations/${encodeURIComponent(input.providerConversationId)}/messages`,
    {
      method: "POST",
      body: { accountId: input.accountId, message: input.content },
      headers: { "Idempotency-Key": input.idempotencyKey }
    }
  );
}

function providerMessageId(result: SendResult) {
  return result.message?.platformMessageId ?? result.message?.id ?? result.id ?? null;
}

/** Comprueba tenant, canal y última transición humana dentro del contexto interno. */
async function target(tx: Tx, input: DispatchInput) {
  const [tenant, conversation] = await Promise.all([
    tx.tenant.findUnique({ where: { id: input.tenantId },
      select: { estado: true, agentEnabled: true, followupEnabled: true } }),
    tx.conversation.findFirst({ where: { id: input.conversationId, tenantId: input.tenantId },
      select: { id: true, canal: true, estado: true, channelAccountId: true, providerConversationId: true } })
  ]);
  if (!conversation) throw new ApiError("NOT_FOUND", "El recurso no existe.");
  if (tenant?.estado !== "activo" || !tenant.agentEnabled || conversation.canal !== "whatsapp") return null;
  if (!conversation.channelAccountId || !conversation.providerConversationId) return null;
  if (input.handoffId) {
    if (conversation.estado !== "esperando_humano") return null;
    const handoff = await tx.handoff.findFirst({
      where: { id: input.handoffId, tenantId: input.tenantId,
        conversationId: conversation.id, resultado: "pendiente" },
      select: { id: true }
    });
    if (!handoff) return null;
  } else if (conversation.estado !== "bot") return null;
  const channel = await tx.channelAccount.findFirst({
    where: { id: conversation.channelAccountId, tenantId: input.tenantId, estado: "activa" },
    select: { zernioAccountId: true }
  });
  if (!channel) return null;
  return {
    accountId: channel.zernioAccountId,
    providerConversationId: conversation.providerConversationId,
    followupEnabled: tenant.followupEnabled
  };
}

/**
 * Guarda el intento antes de llamar al proveedor. Un intento sin 2xx local
 * queda incierto: ni un timeout ni un 5xx autorizan un reenvío automático.
 */
export async function dispatchAgentMessage(input: DispatchInput, send: SendMessage = sendThroughZernio) {
  const ctx = { rol: "worker" as const, tenantId: input.tenantId };
  const prepared = await runWithContext(ctx, async (tx) => {
    const owned = await tx.conversation.findFirst({
      where: { id: input.conversationId, tenantId: input.tenantId }, select: { id: true }
    });
    if (!owned) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    const existing = await tx.outboundMessageAttempt.findUnique({
      where: { tenantId_operationKey: { tenantId: input.tenantId, operationKey: input.operationKey } }
    });
    if (existing) return { attempt: existing, created: false };
    if (!await target(tx, input)) return null;
    return outbound.prepareAttempt(tx, {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      operationKey: input.operationKey,
      content: input.content,
      handoffId: input.handoffId
    });
  });
  if (!prepared) return { status: "cancelled" as const };
  const { attempt, created } = prepared;
  if (attempt.conversationId !== input.conversationId || attempt.content !== input.content ||
    attempt.handoffId !== (input.handoffId ?? null)) {
    throw new ApiError("CONFLICT", "La clave de envío ya fue usada con otro mensaje.");
  }
  if (!created) {
    if (attempt.status === "sent") return { status: "replayed" as const, providerMessageId: attempt.providerMessageId };
    if (attempt.status === "cancelled") return { status: "cancelled" as const };
    throw new ApiError("CONFLICT", "El resultado del envío requiere revisión antes de continuar.");
  }

  try {
    return await runWithContext(ctx, async (tx) => {
      // El envío espera a una suspensión o toma humana en curso. A la inversa,
      // esas transiciones esperan a que termine esta llamada corta al proveedor.
      await tx.$queryRaw`select id from tenants where id = ${input.tenantId}::uuid for share`;
      await tx.$queryRaw`select id from conversations where id = ${input.conversationId}::uuid for update`;
      const current = await target(tx, input);
      if (!current) {
        await outbound.markCancelled(tx, attempt.id);
        return { status: "cancelled" as const };
      }
      const result = await send({
        accountId: current.accountId,
        providerConversationId: current.providerConversationId,
        content: attempt.content,
        idempotencyKey: attempt.id
      });
      const messageId = providerMessageId(result);
      await outbound.markSent(tx, attempt.id, messageId);
      await tx.conversationMessage.create({ data: {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        rol: "agente_ia",
        tipo: "texto",
        contenido: attempt.content,
        providerMessageId: messageId,
        meta: { outbound_attempt_id: attempt.id, ...(input.handoffId ? { handoff_id: input.handoffId } : {}) }
      } });
      if (!input.handoffId && current.followupEnabled) {
        await tx.conversation.update({ where: { id: input.conversationId }, data: {
          followupStep: 1,
          followupDueAt: new Date(Date.now() + FOLLOWUP_DELAY_MS),
          followupClaimedAt: null
        } });
      }
      return { status: "sent" as const, providerMessageId: messageId };
    }, { maxWait: 5000, timeout: 30000 });
  } catch (error) {
    await runWithContext(ctx, (tx) => outbound.markUncertain(tx, attempt.id));
    throw error;
  }
}
