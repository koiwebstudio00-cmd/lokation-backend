import { zernioFetch } from "../../lib/zernio.js";
import { runWithContext } from "../../lib/prisma.js";
import * as agentRepo from "./repo.js";
import * as followups from "./followup.repo.js";
import { finalizarSeguimientoFantasma } from "./service.js";

const WORKER_CTX = { rol: "worker" as const };
const FOLLOWUP_DELAY_MS = 2 * 60 * 60 * 1000;
const FOLLOWUP_LEASE_MS = 5 * 60 * 1000;
const FOLLOWUP_RETRY_MS = 5 * 60 * 1000;
const FOLLOWUP_WINDOW_MS = 24 * 60 * 60 * 1000;

interface SendResult {
  id?: string;
  message?: { id?: string; platformMessageId?: string };
}

type SendFollowup = (input: {
  accountId: string;
  providerConversationId: string;
  message: string;
}) => Promise<SendResult>;

async function sendThroughZernio(input: {
  accountId: string;
  providerConversationId: string;
  message: string;
}) {
  return zernioFetch<SendResult>(
    `/inbox/conversations/${encodeURIComponent(input.providerConversationId)}/messages`,
    {
      method: "POST",
      body: { accountId: input.accountId, message: input.message }
    }
  );
}

function providerMessageId(result: SendResult) {
  return result.message?.platformMessageId ?? result.message?.id ?? result.id ?? null;
}

export interface FollowupProcessOptions {
  /** Reloj y transporte inyectables para pruebas deterministas. */
  now?: Date;
  send?: SendFollowup;
}

/** Procesa una pasada de seguimientos vencidos. El claim hace seguro correr varias réplicas. */
export async function processFollowupsOnce(opts: FollowupProcessOptions = {}) {
  const now = opts.now ?? new Date();
  const send = opts.send ?? sendThroughZernio;
  const leaseExpiredAt = new Date(now.getTime() - FOLLOWUP_LEASE_MS);
  const due = await runWithContext(WORKER_CTX, (tx) =>
    followups.listDue(tx, now, leaseExpiredAt)
  );
  let processed = 0;

  for (const candidate of due) {
    const claimed = await runWithContext(WORKER_CTX, (tx) =>
      followups.claim(tx, candidate.id, candidate.followupStep, now, leaseExpiredAt)
    );
    if (!claimed?.followupClaimedAt) continue;
    processed += 1;

    const context = await runWithContext(
      { rol: "agent", tenantId: claimed.tenantId },
      async (tx) => {
        const [settings, channel] = await Promise.all([
          agentRepo.findTenantFollowupSettings(tx, claimed.tenantId),
          agentRepo.findActiveChannelAccount(tx, claimed.channelAccountId!)
        ]);
        return { settings, channel };
      }
    );
    const { settings, channel } = context;
    if (!settings?.agentEnabled || !settings.followupEnabled) {
      await runWithContext(WORKER_CTX, (tx) =>
        followups.cancel(tx, claimed.id, claimed.followupClaimedAt!)
      );
      continue;
    }

    // La etapa final ya no necesita enviar nada a Zernio: aunque la cuenta se
    // desconecte después del segundo mensaje, la asignación debe completarse.
    if (claimed.followupStep === 3) {
      await finalizarSeguimientoFantasma(
        claimed.tenantId,
        claimed.id,
        claimed.followupClaimedAt,
        now
      );
      continue;
    }

    if (!channel) {
      await runWithContext(WORKER_CTX, (tx) =>
        followups.retryLater(
          tx,
          claimed.id,
          claimed.followupClaimedAt!,
          new Date(now.getTime() + FOLLOWUP_RETRY_MS)
        )
      );
      continue;
    }

    // Si la API estuvo caída más de la ventana admitida, no enviamos mensajes
    // viejos fuera de contexto: pasamos directamente a la clasificación final.
    if (
      claimed.lastLeadMessageAt &&
      now.getTime() - claimed.lastLeadMessageAt.getTime() >= FOLLOWUP_WINDOW_MS
    ) {
      await runWithContext(WORKER_CTX, (tx) =>
        followups.promoteToFinal(tx, claimed.id, claimed.followupClaimedAt!, now)
      );
      continue;
    }

    const message = claimed.followupStep === 1
      ? settings.followupFirstMessage
      : settings.followupSecondMessage;
    try {
      const stillActive = await runWithContext(WORKER_CTX, (tx) =>
        followups.isClaimActive(
          tx,
          claimed.id,
          claimed.followupStep,
          claimed.followupClaimedAt!
        )
      );
      if (!stillActive) continue;
      const result = await send({
        accountId: channel.zernioAccountId,
        providerConversationId: claimed.providerConversationId!,
        message
      });
      await runWithContext(WORKER_CTX, (tx) =>
        followups.completeMessage(tx, {
          tenantId: claimed.tenantId,
          conversationId: claimed.id,
          claimedAt: claimed.followupClaimedAt!,
          currentStep: claimed.followupStep as 1 | 2,
          nextDueAt: new Date(now.getTime() + FOLLOWUP_DELAY_MS),
          content: message,
          providerMessageId: providerMessageId(result)
        })
      );
    } catch (error) {
      console.error(`[followups] error en conversación ${claimed.id}:`, error);
      await runWithContext(WORKER_CTX, (tx) =>
        followups.retryLater(
          tx,
          claimed.id,
          claimed.followupClaimedAt!,
          new Date(now.getTime() + FOLLOWUP_RETRY_MS)
        )
      );
    }
  }

  return processed;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startFollowupWorker() {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    processFollowupsOnce()
      .catch((error) => console.error("[followups] worker error:", error))
      .finally(() => {
        running = false;
      });
  }, 30_000);
  timer.unref();
}

export function stopFollowupWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
