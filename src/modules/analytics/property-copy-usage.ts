import type { AccessClaims } from "../../lib/tokens.js";
import { runWithContext } from "../../lib/prisma.js";

export async function propertyCopyUsage(auth: AccessClaims) {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  const usage = await runWithContext({
    tenantId: auth.tenantId,
    userId: auth.userId,
    rol: auth.rol
  }, (tx) => tx.propertyCopyUsage.aggregate({
    where: { tenantId: auth.tenantId!, createdAt: { gte: from, lt: to } },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true }
  }));
  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    generations: usage._count._all,
    input_tokens: usage._sum.inputTokens ?? 0,
    output_tokens: usage._sum.outputTokens ?? 0
  };
}
