import type { Tx } from "../../lib/prisma.js";

export async function prepareAttempt(
  tx: Tx,
  input: { tenantId: string; conversationId: string; operationKey: string; content: string }
) {
  const { count } = await tx.outboundMessageAttempt.createMany({ data: [input], skipDuplicates: true });
  const attempt = await tx.outboundMessageAttempt.findUniqueOrThrow({
    where: { tenantId_operationKey: { tenantId: input.tenantId, operationKey: input.operationKey } }
  });
  if (attempt.conversationId !== input.conversationId) {
    throw new Error("Clave de envío reutilizada para otra conversación");
  }
  return { attempt, created: count === 1 };
}

export function markSent(tx: Tx, id: string, providerMessageId: string | null) {
  return tx.outboundMessageAttempt.updateMany({
    where: { id, status: "attempted" },
    data: { status: "sent", providerMessageId, resolvedAt: new Date() }
  });
}

export function markUncertain(tx: Tx, id: string) {
  return tx.outboundMessageAttempt.updateMany({
    where: { id, status: "attempted" },
    data: { status: "uncertain", resolvedAt: new Date() }
  });
}
