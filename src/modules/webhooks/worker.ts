// Worker de entregas (outbox): toma deliveries pendientes y hace el POST con
// firma HMAC. Reintentos con backoff exponencial. Ver webhooks.md §3-4.
import { createHmac, randomUUID } from "node:crypto";
import { runWithContext } from "../../lib/prisma.js";

const WORKER_CTX = { rol: "worker" as const };
const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
const MAX_INTENTOS = BACKOFF_MINUTES.length;
const TIMEOUT_MS = 10_000;
const CLAIM_LEASE_MS = 60_000;
const BATCH = 20;

interface PendingDelivery {
  id: string;
  evento: string;
  payload: unknown;
  intentos: number;
  createdAt: Date;
  endpoint: { id: string; url: string; secret: string; tenantId: string | null; activo: boolean };
}

async function deliver(d: PendingDelivery): Promise<{ ok: boolean; status: number | null }> {
  const body = JSON.stringify({
    id: d.id,
    evento: d.evento,
    tenant_id: d.endpoint.tenantId,
    created_at: d.createdAt.toISOString(),
    data: d.payload
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", d.endpoint.secret).update(body).digest("hex");

  try {
    const res = await fetch(d.endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Ubikka-Webhooks/1.0",
        "X-Ubikka-Event": d.evento,
        "X-Ubikka-Delivery": d.id,
        "X-Ubikka-Signature": `sha256=${signature}`,
        "X-Ubikka-Timestamp": timestamp
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}

/** Procesa un lote de deliveries pendientes. Exportado para tests. */
export async function processDeliveriesOnce(): Promise<number> {
  const pending: PendingDelivery[] = await runWithContext(WORKER_CTX, (tx) =>
    tx.webhookDelivery.findMany({
      where: {
        estado: "pendiente",
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
        endpoint: { activo: true }
      },
      include: { endpoint: true },
      orderBy: { createdAt: "asc" },
      take: BATCH
    })
  );

  let processed = 0;
  for (const d of pending) {
    const claimId = randomUUID();
    const claimedAt = new Date();
    const leaseExpiredAt = new Date(claimedAt.getTime() - CLAIM_LEASE_MS);
    const claimed = await runWithContext(WORKER_CTX, (tx) =>
      tx.webhookDelivery.updateMany({
        where: {
          id: d.id,
          estado: "pendiente",
          OR: [{ claimId: null }, { claimedAt: { lte: leaseExpiredAt } }]
        },
        data: { claimId, claimedAt }
      })
    );
    if (claimed.count === 0) continue;
    processed += 1;
    if (d.endpoint.tenantId) {
      const tenant = await runWithContext({ rol: "auth" }, (tx) =>
        tx.tenant.findUnique({ where: { id: d.endpoint.tenantId! }, select: { estado: true } })
      );
      if (tenant?.estado !== "activo") {
        await runWithContext(WORKER_CTX, (tx) =>
          tx.webhookDelivery.updateMany({
            where: { id: d.id, estado: "pendiente", claimId },
            data: { estado: "fallida", claimId: null, claimedAt: null }
          })
        );
        continue;
      }
    }
    const result = await deliver(d);
    const intentos = d.intentos + 1;

    await runWithContext(WORKER_CTX, async (tx) => {
      if (result.ok) {
        await tx.webhookDelivery.updateMany({
          where: { id: d.id, estado: "pendiente", claimId },
          data: { estado: "entregada", httpStatus: result.status, intentos, claimId: null, claimedAt: null }
        });
      } else if (intentos >= MAX_INTENTOS) {
        await tx.webhookDelivery.updateMany({
          where: { id: d.id, estado: "pendiente", claimId },
          data: { estado: "fallida", httpStatus: result.status, intentos, claimId: null, claimedAt: null }
        });
      } else {
        const minutes = BACKOFF_MINUTES[intentos - 1] ?? 720;
        await tx.webhookDelivery.updateMany({
          where: { id: d.id, estado: "pendiente", claimId },
          data: {
            httpStatus: result.status,
            intentos,
            nextRetryAt: new Date(Date.now() + minutes * 60_000),
            claimId: null,
            claimedAt: null
          }
        });
      }
    });
  }
  return processed;
}

let timer: NodeJS.Timeout | null = null;

/** Loop del worker (cada 15 s). Se inicia desde server.ts — no en tests. */
export function startWebhookWorker() {
  if (timer) return;
  timer = setInterval(() => {
    processDeliveriesOnce().catch((err) => console.error("[webhooks] worker error:", err));
  }, 15_000);
  timer.unref();
}

export function stopWebhookWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
