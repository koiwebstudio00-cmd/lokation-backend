// Worker de la cola de eventos entrantes de Zernio: agrupa las ráfagas del
// lead, resuelve accountId → tenant y despierta al agente de IA. Ver
// lamelas-agent/docs/plan-implementacion-zernio.md §5.3.
//
// Decisión (2026-08-17, revisada 2026-08-28): los message.received siguen siendo
// puro transporte; n8n registra la entrada para no duplicarla. El worker sí
// procesa message.sent desde whatsapp_business_app porque esa intervención no
// entra al workflow: registra al vendedor y silencia el bot en una transacción.
//
// Decisión (2026-08-23): el BUFFER DE RÁFAGAS vive acá y no en n8n. Kapso
// agrupaba del lado de ellos y mandaba un solo webhook con `data: [...]`;
// Zernio emite uno por mensaje. Sin agrupar, un lead que escribe "hola" /
// "busco depto" / "en yerba buena" dispara tres ejecuciones y Sofi contesta
// tres veces con contexto parcial. Se agrupa acá porque la cola ya es una
// tabla de Postgres (persistente, inspeccionable y testeable) y porque el
// equivalente en n8n exigiría Redis y dejaría ejecuciones colgadas por cada
// mensaje descartado.
//
// Solo WhatsApp por ahora (regla 10 — Instagram queda para más adelante).
import { config } from "../../config.js";
import { emitEvent } from "../../lib/events.js";
import { runWithContext } from "../../lib/prisma.js";
import * as channels from "./channels.repo.js";
import * as webhookRepo from "./zernioWebhook.repo.js";

const WORKER_CTX = { rol: "worker" as const };

// Suficientemente grande para que una ráfaga completa entre en una sola pasada:
// si se partiera en dos lotes, la segunda mitad saldría como un turno aparte y
// el buffer no habría servido de nada.
const BATCH = 100;

interface ZernioEventPayload {
  id?: string;
  event?: string;
  // Zernio manda los dos y son el mismo valor: `id` y `accountId` ("canonical
  // field for account filtering", según la doc). Aceptamos ambos para no
  // depender de cuál incluya cada tipo de evento.
  account?: { id?: string; accountId?: string; platform?: string };
  message?: {
    id?: string;
    platformMessageId?: string;
    conversationId?: string;
    source?: string;
    text?: string | { body?: string };
    attachments?: Array<{ type?: string; url?: string }>;
  };
  conversation?: { id?: string; participantId?: string };
}

interface PendingEvent {
  id: string;
  zernioEventId: string;
  evento: string;
  payload: unknown;
  intentos: number;
  recibidoAt: Date;
}

/** Errores que no tiene sentido reintentar (configuración faltante, no un blip de red). */
class PermanentError extends Error {}

/**
 * Reenvía a n8n la ráfaga completa de una conversación, en el mismo formato
 * `data: [...]` que mandaba Kapso — así el nodo `normalizar` sigue leyendo una
 * lista y no hay que sostener dos shapes distintos del lado de n8n.
 * Tira si la llamada falla: el caller lo trata como transitorio y reintenta.
 */
async function despertarAgente(
  cuenta: { id: string; tenantId: string; canal: string; zernioAccountId: string },
  providerConversationId: string,
  payloads: unknown[]
) {
  if (!config.N8N_WHATSAPP_WEBHOOK_URL) {
    throw new PermanentError("N8N_WHATSAPP_WEBHOOK_URL no configurado");
  }
  const res = await fetch(config.N8N_WHATSAPP_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenant_id: cuenta.tenantId,
      canal: cuenta.canal,
      channel_account_id: cuenta.id,
      zernio_account_id: cuenta.zernioAccountId,
      provider_conversation_id: providerConversationId,
      data: payloads
    }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!res.ok) {
    throw new Error(`n8n respondió ${res.status} al trigger de WhatsApp`);
  }
}

type ResultadoEvento = { ok: true } | { ok: false; permanente: boolean; error: string };

function payloadDe(e: PendingEvent) {
  return e.payload as ZernioEventPayload;
}

function accountIdDe(p: ZernioEventPayload): string | undefined {
  return p.account?.accountId ?? p.account?.id;
}

/**
 * Clave de agrupación de la ráfaga. Se usa account + conversation para que dos
 * números nunca mezclen mensajes si el proveedor reutiliza IDs.
 */
function conversationIdDe(p: ZernioEventPayload): string | undefined {
  return p.message?.conversationId ?? p.conversation?.id;
}

function sourceDe(p: ZernioEventPayload): string | undefined {
  return p.message?.source;
}

function contenidoSalienteDe(p: ZernioEventPayload) {
  const text = p.message?.text;
  if (typeof text === "string" && text.trim()) return text.trim();
  if (typeof text === "object" && text?.body?.trim()) return text.body.trim();
  const attachment = p.message?.attachments?.[0];
  if (attachment?.type === "image") return "[Imagen enviada desde WhatsApp Business]";
  if (attachment?.type === "audio") return "[Audio enviado desde WhatsApp Business]";
  if (attachment) return "[Archivo enviado desde WhatsApp Business]";
  return "[Mensaje enviado desde WhatsApp Business]";
}

function tipoSalienteDe(p: ZernioEventPayload): "texto" | "audio" | "imagen" | "documento" {
  const type = p.message?.attachments?.[0]?.type;
  if (type === "image") return "imagen";
  if (type === "audio") return "audio";
  if (type) return "documento";
  return "texto";
}

function leadEventPayload(l: NonNullable<Awaited<ReturnType<typeof webhookRepo.findLeadForEvent>>>) {
  return {
    id: l.id,
    tenant_id: l.tenantId,
    property_id: l.propertyId,
    assigned_to: l.assignedTo,
    canal: l.canal,
    nombre: l.nombre,
    email: l.email,
    telefono: l.telefono,
    mensaje: l.mensaje,
    estado: l.estado,
    tomado_at: l.tomadoAt,
    tomado_por: l.tomadoPor,
    tomado_origen: l.tomadoOrigen
  };
}

async function registrarIntervencionHumana(
  cuenta: { id: string; tenantId: string; zernioAccountId: string },
  event: PendingEvent
) {
  const payload = payloadDe(event);
  const providerConversationId = conversationIdDe(payload);
  if (!providerConversationId) throw new PermanentError("message.sent sin conversationId");

  await runWithContext({ rol: "worker", tenantId: cuenta.tenantId }, async (tx) => {
    let conversation = await webhookRepo.findProviderConversation(
      tx,
      cuenta.id,
      providerConversationId
    );

    const contactRef = payload.conversation?.participantId;
    if (!conversation && contactRef) {
      const legacy = await webhookRepo.findLegacyWhatsappConversation(
        tx,
        cuenta.tenantId,
        contactRef
      );
      if (legacy) {
        conversation = await webhookRepo.attachProviderIdentity(
          tx,
          legacy.id,
          cuenta.id,
          providerConversationId
        );
      }
    }

    // Una conversación iniciada enteramente desde la app todavía no tiene un
    // lead fiable. El evento queda auditado, pero no se inventa identidad.
    if (!conversation) return;

    const providerMessageId =
      payload.message?.platformMessageId ?? payload.message?.id ?? payload.id ?? event.zernioEventId;
    const attachment = payload.message?.attachments?.[0];
    await webhookRepo.insertExternalMessage(tx, {
      tenantId: cuenta.tenantId,
      conversationId: conversation.id,
      contenido: contenidoSalienteDe(payload),
      tipo: tipoSalienteDe(payload),
      mediaUrl: attachment?.url ?? null,
      providerMessageId,
      meta: {
        source: "whatsapp_business_app",
        zernio_account_id: cuenta.zernioAccountId,
        provider_conversation_id: providerConversationId
      }
    });

    const tomadoAt = new Date();
    await webhookRepo.markConversationHuman(tx, conversation.id);
    await webhookRepo.closePendingHandoff(tx, conversation.id, tomadoAt);
    const toma = await webhookRepo.markLeadTakenFromBusinessApp(tx, conversation.leadId, tomadoAt);
    if (toma.count > 0) {
      const lead = await webhookRepo.findLeadForEvent(tx, conversation.leadId);
      if (lead) await emitEvent(tx, "lead.updated", leadEventPayload(lead));
    }
  });
}

/**
 * Nunca tira para casos de negocio esperados (cuenta desconocida): esos son
 * `permanente: true`, no tiene sentido reintentarlos. Si `despertarAgente` tira
 * por un `PermanentError`, tampoco — cualquier otro throw se trata como
 * transitorio (n8n caído momentáneamente, timeout de red).
 */
async function procesarGrupo(grupo: PendingEvent[]): Promise<ResultadoEvento> {
  const primero = grupo[0]!;
  const accountId = accountIdDe(payloadDe(primero));
  if (!accountId) return { ok: false, permanente: true, error: "evento sin account.id" };

  const cuenta = await runWithContext(WORKER_CTX, (tx) =>
    channels.findTenantByZernioAccountId(tx, accountId)
  );
  if (!cuenta) {
    // Cuenta desconocida o desconectada: no hay tenant al que atribuirle el
    // evento. No es transitorio — reintentar no lo va a resolver.
    return { ok: false, permanente: true, error: "cuenta no encontrada o inactiva" };
  }
  const tenant = await runWithContext({ rol: "auth" }, (tx) =>
    tx.tenant.findUnique({ where: { id: cuenta.tenantId }, select: { estado: true } })
  );
  if (tenant?.estado !== "activo") {
    return { ok: false, permanente: true, error: "inmobiliaria suspendida" };
  }

  if (primero.evento === "message.received") {
    const providerConversationId = conversationIdDe(payloadDe(primero));
    if (!providerConversationId) {
      return { ok: false, permanente: true, error: "message.received sin conversationId" };
    }
    try {
      await despertarAgente(cuenta, providerConversationId, grupo.map((e) => e.payload));
    } catch (err) {
      if (err instanceof PermanentError) {
        return { ok: false, permanente: true, error: err.message };
      }
      throw err;
    }
  } else if (
    primero.evento === "message.sent" &&
    sourceDe(payloadDe(primero)) === "whatsapp_business_app"
  ) {
    try {
      await registrarIntervencionHumana(cuenta, primero);
    } catch (err) {
      if (err instanceof PermanentError) {
        return { ok: false, permanente: true, error: err.message };
      }
      throw err;
    }
  }
  // Otros eventos (message.sent de cloud_api, delivered/read/failed,
  // conversation.started, account.disconnected) se auditan sin despertar a Sofi.

  return { ok: true };
}

// Zernio ya nos entregó el evento y lo confirmamos con 200 al recibirlo: si
// después el PROCESAMIENTO falla, Zernio no lo va a reintentar por nosotros.
// Un puñado de reintentos propios cubre lo transitorio (DB momentáneamente
// caída) sin convertir un error permanente en un loop.
const MAX_INTENTOS = 5;

/**
 * Arma los grupos a despachar en esta pasada.
 *
 * Los `message.received` se agrupan por conversación y solo salen cuando la
 * ráfaga se enfrió: si el mensaje más nuevo del grupo tiene menos de
 * `bufferMs`, se deja para la próxima vuelta por si el lead sigue escribiendo.
 * Todo lo demás sale de a uno y sin esperar — no hay ráfaga que juntar.
 */
function armarGrupos(pendientes: PendingEvent[], ahora: Date, bufferMs: number): PendingEvent[][] {
  const rafagas = new Map<string, PendingEvent[]>();
  const sueltos: PendingEvent[][] = [];

  for (const e of pendientes) {
    const payload = payloadDe(e);
    const conversationId = e.evento === "message.received" ? conversationIdDe(payload) : undefined;
    const accountId = e.evento === "message.received" ? accountIdDe(payload) : undefined;
    if (!conversationId || !accountId) {
      // Sin conversación (o evento de otro tipo) no hay nada que agrupar. Un
      // message.received sin conversationId cae acá y va a fallar como
      // permanente más adelante, que es lo correcto.
      sueltos.push([e]);
      continue;
    }
    const key = `${accountId}:${conversationId}`;
    const grupo = rafagas.get(key);
    if (grupo) grupo.push(e);
    else rafagas.set(key, [e]);
  }

  const corte = ahora.getTime() - bufferMs;
  const maduras = [...rafagas.values()].filter((grupo) =>
    grupo.every((e) => e.recibidoAt.getTime() <= corte)
  );

  return [...sueltos, ...maduras];
}

export interface ProcessOptions {
  /** Inyectable para los tests: evita depender del reloj real para el buffer. */
  ahora?: Date;
  bufferMs?: number;
}

/**
 * Procesa una pasada de la cola. Devuelve cuántos EVENTOS se despacharon (no
 * cuántos grupos), así un `while (await processChannelEventsOnce() > 0)` sigue
 * sirviendo para drenar.
 */
export async function processChannelEventsOnce(opts: ProcessOptions = {}): Promise<number> {
  const ahora = opts.ahora ?? new Date();
  const bufferMs = opts.bufferMs ?? config.ZERNIO_BUFFER_MS;

  const pendientes: PendingEvent[] = await runWithContext(WORKER_CTX, (tx) =>
    tx.channelWebhookEvent.findMany({
      where: { estado: "pendiente" },
      orderBy: { recibidoAt: "asc" },
      take: BATCH
    })
  );

  const grupos = armarGrupos(pendientes, ahora, bufferMs);
  let despachados = 0;

  for (const grupo of grupos) {
    let resultado: ResultadoEvento;
    try {
      resultado = await procesarGrupo(grupo);
    } catch (err) {
      resultado = { ok: false, permanente: false, error: (err as Error).message };
    }

    // Los intentos se cuentan por grupo: si la ráfaga entera falló, todos sus
    // eventos avanzan el contador juntos y se agotan juntos.
    const intentos = Math.max(...grupo.map((e) => e.intentos)) + 1;
    const ids = grupo.map((e) => e.id);

    await runWithContext(WORKER_CTX, (tx) =>
      tx.channelWebhookEvent.updateMany({
        where: { id: { in: ids } },
        data: resultado.ok
          ? { estado: "procesado", procesadoAt: ahora }
          : resultado.permanente || intentos >= MAX_INTENTOS
            ? { estado: "error", errorDetalle: resultado.error, intentos }
            : { errorDetalle: resultado.error, intentos }
      })
    );
    despachados += grupo.length;
  }

  return despachados;
}

let timer: NodeJS.Timeout | null = null;

/** Loop del worker (cada 5 s — acá la latencia se nota del lado del vendedor). */
export function startZernioEventsWorker() {
  if (timer) return;
  timer = setInterval(() => {
    processChannelEventsOnce().catch((err) => console.error("[zernio-events] worker error:", err));
  }, 5_000);
  timer.unref();
}

export function stopZernioEventsWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
