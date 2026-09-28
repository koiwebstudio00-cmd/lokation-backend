// Webhook entrante de Zernio — un único endpoint compartido por todos los
// tenants (Zernio no ofrece "un webhook por profile"). Sin sesión ni API key:
// la seguridad es la firma HMAC. Ver
// lamelas-agent/docs/plan-implementacion-zernio.md §5.
//
// Monta ANTES del express.json() global en app.ts: necesita el body crudo
// para verificar la firma contra los mismos bytes que mandó Zernio, no contra
// un JSON.stringify(JSON.parse(...)) que podría no calzar byte a byte.
import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { config } from "../../config.js";
import { runWithContext } from "../../lib/prisma.js";

export const zernioWebhookRoutes = Router();

const WORKER_CTX = { rol: "worker" as const };

function signatureValida(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const esperada = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

zernioWebhookRoutes.post("/", async (req, res) => {
  if (!config.ZERNIO_WEBHOOK_SECRET) {
    // Sin secret configurado no hay forma de verificar el origen — falla
    // cerrado en vez de aceptar sin validar.
    console.error("[zernio-webhook] ZERNIO_WEBHOOK_SECRET no configurado");
    res.status(500).end();
    return;
  }

  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    res.status(400).end();
    return;
  }
  if (!signatureValida(rawBody, req.get("x-zernio-signature"), config.ZERNIO_WEBHOOK_SECRET)) {
    res.status(400).end();
    return;
  }

  let event: { id?: string; event?: string };
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).end();
    return;
  }
  if (!event.id || !event.event) {
    res.status(400).end();
    return;
  }

  // Encolar y responder ya: Zernio exige 2xx en <5s. El worker procesa aparte
  // (regla 8, mismo espíritu que el outbox saliente pero en sentido inverso).
  try {
    await runWithContext(WORKER_CTX, (tx) =>
      tx.channelWebhookEvent.create({
        data: { zernioEventId: event.id!, evento: event.event!, payload: event as object }
      })
    );
  } catch (err) {
    // P2002 = ya lo teníamos (Zernio entrega at-least-once): no es un error,
    // es el caso de dedupe funcionando. Cualquier otra cosa, sí es un 500 real.
    if ((err as { code?: string }).code !== "P2002") {
      // Nunca el payload (puede traer texto del lead): solo el código de
      // Prisma y el mensaje, que es lo que sirve para diagnosticar.
      console.error(
        "[zernio-webhook] error al encolar:",
        (err as { code?: string }).code ?? "sin code",
        (err as Error).message
      );
      res.status(500).end();
      return;
    }
  }

  res.status(200).json({ ok: true });
});
