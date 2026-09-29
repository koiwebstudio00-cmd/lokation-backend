// Zernio: aislamiento RLS de channel_accounts, firma/idempotencia del webhook
// entrante y el worker que alimenta al agente de IA. Ver
// lamelas-agent/docs/plan-implementacion-zernio.md §5, §8.
//
// Ojo: acá NUNCA se llama a la API real de Zernio (channels.service.ts) — los
// tests fijan channel_accounts directo en la BD (adminDb) y ejercitan solo el
// transporte propio (webhook entrante + worker), que es donde vive el riesgo
// de aislamiento multi-tenant. Los endpoints de conexión (getConnectUrl,
// completeConnection) hacen fetch a un servicio externo real y quedan fuera
// de esta suite a propósito.
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { processChannelEventsOnce } from "../src/modules/integrations/zernioWebhook.worker.js";
import {
  adminDb,
  DB_AVAILABLE,
  seedTenantWithUsers,
  TEST_PASSWORD,
  truncateAll
} from "./helpers.js";

// Puerto fijo: tiene que coincidir con N8N_WHATSAPP_WEBHOOK_URL en test/setup.ts
// (config.ts lo lee al importarse, antes de que este archivo pueda tocarlo).
const N8N_MOCK_PORT = 34599;

const WEBHOOK_SECRET = "test-zernio-secret"; // fijado en test/setup.ts

function firmar(body: string) {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

function eventoWhatsapp(
  accountId: string,
  opts: { conversationId?: string; text?: string } = {}
) {
  const conversationId = opts.conversationId ?? "conv_default";
  return {
    id: randomUUID(),
    event: "message.received",
    account: { id: accountId, accountId, platform: "whatsapp" },
    message: {
      id: `wamid.${randomUUID()}`,
      text: opts.text ?? "Hola, vi el depto de Barrio Norte",
      conversationId,
      sender: { id: "5493810000099", phoneNumber: "+5493810000099", name: "Marcela" }
    },
    conversation: { id: conversationId, participantId: "5493810000099" }
  };
}

function eventoWhatsappSaliente(
  accountId: string,
  opts: {
    conversationId?: string;
    source?: "whatsapp_business_app" | "cloud_api";
    participantId?: string;
    text?: string;
  } = {}
) {
  const conversationId = opts.conversationId ?? "conv_saliente_business_app";
  return {
    id: randomUUID(),
    event: "message.sent",
    account: { id: accountId, accountId, platform: "whatsapp" },
    message: {
      id: `wamid.${randomUUID()}`,
      text: opts.text ?? "Mensaje enviado por Lamelas",
      conversationId,
      source: opts.source ?? "whatsapp_business_app"
    },
    conversation: { id: conversationId, participantId: opts.participantId ?? "5493810000099" }
  };
}

// El worker espera un silencio antes de despachar una ráfaga. En vez de dormir
// (o de timers falsos, que pelean con las promesas de Prisma) se le adelanta el
// reloj: `processChannelEventsOnce` acepta `ahora` justamente para esto.
const yaSeEnfrio = () => ({ ahora: new Date(Date.now() + 60_000) });

describe.runIf(DB_AVAILABLE)("Zernio: creación idempotente del profile", () => {
  const app = buildApp();
  let admin: ReturnType<typeof request.agent>;
  let csrf = "";
  let tenantId = "";

  beforeAll(async () => {
    await truncateAll();
    const seeded = await seedTenantWithUsers("zern-profile");
    tenantId = seeded.tenant.id;
    admin = request.agent(app);
    const login = await admin.post("/v1/auth/login").send({
      email: seeded.admin.email,
      password: TEST_PASSWORD
    });
    csrf = login.body.csrf_token as string;
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reutiliza el profile existente cuando Zernio responde profile_name_conflict", async () => {
    const existingProfileId = "profile_existing_1";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());

      if (url.pathname === "/api/v1/profiles") {
        return new Response(
          JSON.stringify({
            error: "A profile with this name already exists",
            code: "profile_name_conflict",
            details: { existingProfileId }
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.pathname === "/api/v1/connect/whatsapp") {
        expect(url.searchParams.get("profileId")).toBe(existingProfileId);
        expect(url.searchParams.get("redirect_url")).toBe(
          "http://localhost:3000/whatsapp/conectar/callback"
        );
        return Response.json({ authUrl: "https://zernio.test/connect", state: "state" });
      }

      throw new Error(`Request inesperado a ${url.toString()}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await admin.get("/v1/integrations/channels/whatsapp/connect-url");

    expect(res.status).toBe(200);
    expect(res.body.auth_url).toBe("https://zernio.test/connect");
    expect(
      (await adminDb().tenant.findUnique({ where: { id: tenantId } }))?.zernioProfileId
    ).toBe(existingProfileId);
  });

  it("mantiene la cuenta activa si Zernio falla al desconectarla", async () => {
    const channel = await adminDb().channelAccount.create({
      data: {
        tenantId,
        canal: "whatsapp",
        zernioProfileId: "profile_existing_1",
        zernioAccountId: "account_disconnect_failure"
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "Temporal failure", code: "upstream_error" }, { status: 503 })
      )
    );

    const res = await admin
      .delete(`/v1/integrations/channels/${channel.id}`)
      .set("x-csrf-token", csrf);

    expect(res.status).toBe(409);
    expect(
      (await adminDb().channelAccount.findUniqueOrThrow({ where: { id: channel.id } })).estado
    ).toBe("activa");
    await adminDb().channelAccount.delete({ where: { id: channel.id } });
  });

  it("marca desconectada si Zernio responde que la cuenta ya no existe", async () => {
    const channel = await adminDb().channelAccount.create({
      data: {
        tenantId,
        canal: "whatsapp",
        zernioProfileId: "profile_existing_1",
        zernioAccountId: "account_already_disconnected"
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Not found" }, { status: 404 }))
    );

    const res = await admin
      .delete(`/v1/integrations/channels/${channel.id}`)
      .set("x-csrf-token", csrf);

    expect(res.status).toBe(204);
    const desconectada = await adminDb().channelAccount.findUniqueOrThrow({
      where: { id: channel.id }
    });
    expect(desconectada.estado).toBe("desconectada");
    expect(desconectada.connectionMode).toBe("unknown");
    expect(desconectada.disconnectedAt).toBeInstanceOf(Date);

    const health = await admin.get(`/v1/integrations/channels/${channel.id}/health`);
    expect(health.status).toBe(409);
    expect(health.body.error.message).toBe("El número está desconectado.");
  });

  it("no toma un HTTP 200 de health como éxito si Zernio informa status=error", async () => {
    const channel = await adminDb().channelAccount.create({
      data: {
        tenantId,
        canal: "whatsapp",
        zernioProfileId: "profile_existing_1",
        zernioAccountId: "account_unhealthy"
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          status: "error",
          issues: ["Account is marked as inactive"],
          platformConnection: { status: "unknown" }
        })
      )
    );

    const health = await admin.get(`/v1/integrations/channels/${channel.id}/health`);
    expect(health.status).toBe(409);
    expect(health.body.error.message).toBe("Zernio informa que el número no está operativo.");
    await adminDb().channelAccount.delete({ where: { id: channel.id } });
  });
});

describe.runIf(DB_AVAILABLE)("Zernio: RLS de channel_accounts", () => {
  let A: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let B: Awaited<ReturnType<typeof seedTenantWithUsers>>;

  const adminA = () => ({ userId: A.admin.id, tenantId: A.tenant.id, rol: "admin" as const });
  const adminB = () => ({ userId: B.admin.id, tenantId: B.tenant.id, rol: "admin" as const });
  const workerCtx = { rol: "worker" as const };

  beforeAll(async () => {
    await truncateAll();
    A = await seedTenantWithUsers("zerna");
    B = await seedTenantWithUsers("zernb");
  });

  it("el admin conecta un canal de su propio tenant", async () => {
    const canal = await runWithContext(adminA(), (tx) =>
      tx.channelAccount.create({
        data: {
          tenantId: A.tenant.id,
          canal: "whatsapp",
          zernioProfileId: "profile_a",
          zernioAccountId: "acc_a_1",
          conectadaPor: A.admin.id
        }
      })
    );
    expect(canal.estado).toBe("activa");
    expect(canal.connectionMode).toBe("unknown");
    expect(canal.disconnectedAt).toBeNull();
  });

  it("el admin de B no ve el canal de A, ni puede desconectarlo", async () => {
    const desdeB = await runWithContext(adminB(), (tx) => tx.channelAccount.findMany());
    expect(desdeB).toHaveLength(0);

    const { count } = await runWithContext(adminB(), (tx) =>
      tx.channelAccount.updateMany({
        where: { zernioAccountId: "acc_a_1" },
        data: { estado: "desconectada" }
      })
    );
    expect(count).toBe(0);
  });

  it("el admin de B NO puede crear un canal en el tenant de A", async () => {
    await expect(
      runWithContext(adminB(), (tx) =>
        tx.channelAccount.create({
          data: {
            tenantId: A.tenant.id,
            canal: "whatsapp",
            zernioProfileId: "profile_a",
            zernioAccountId: "acc_intruso",
            conectadaPor: B.admin.id
          }
        })
      )
    ).rejects.toThrow();
  });

  it("el contexto worker lee cuentas activas de cualquier tenant pero no puede escribir", async () => {
    const vistas = await runWithContext(workerCtx, (tx) => tx.channelAccount.findMany());
    expect(vistas.map((c) => c.zernioAccountId)).toContain("acc_a_1");

    await expect(
      runWithContext(workerCtx, (tx) =>
        tx.channelAccount.create({
          data: {
            tenantId: A.tenant.id,
            canal: "whatsapp",
            zernioProfileId: "profile_a",
            zernioAccountId: "acc_worker_intruso",
            conectadaPor: A.admin.id
          }
        })
      )
    ).rejects.toThrow();
  });

  it("una sola cuenta activa por tenant y canal (índice parcial)", async () => {
    await expect(
      runWithContext(adminA(), (tx) =>
        tx.channelAccount.create({
          data: {
            tenantId: A.tenant.id,
            canal: "whatsapp",
            zernioProfileId: "profile_a",
            zernioAccountId: "acc_a_2",
            conectadaPor: A.admin.id
          }
        })
      )
    ).rejects.toThrow();
  });
});

describe.runIf(DB_AVAILABLE)("Zernio: webhook entrante — firma, idempotencia y worker", () => {
  const app = buildApp();
  let A: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  const ACCOUNT_ID = "acc_webhook_1";
  let channelAccountId = "";

  // Recibe lo que el worker le reenvía a n8n (despertarAgente) en vez de un
  // n8n real — acá solo importa que el trigger salga, no la lógica de Sofi.
  let n8nMock: Server;
  const n8nRequests: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let n8nRespondWith = 200;
  let n8nResponseGate: Promise<void> | null = null;

  beforeAll(async () => {
    await truncateAll();
    A = await seedTenantWithUsers("zernw");
    const channel = await adminDb().channelAccount.create({
      data: {
        tenantId: A.tenant.id,
        canal: "whatsapp",
        zernioProfileId: "profile_w",
        zernioAccountId: ACCOUNT_ID,
        conectadaPor: A.admin.id
      }
    });
    channelAccountId = channel.id;

    n8nMock = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        n8nRequests.push({ headers: req.headers, body });
        if (n8nResponseGate) await n8nResponseGate;
        res.statusCode = n8nRespondWith;
        res.end();
      });
    });
    await new Promise<void>((resolve) => n8nMock.listen(N8N_MOCK_PORT, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise((resolve) => n8nMock.close(resolve));
  });

  it("rechaza sin firma", async () => {
    const body = JSON.stringify(eventoWhatsapp(ACCOUNT_ID));
    const res = await request(app)
      .post("/webhooks/zernio")
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(400);
  });

  it("rechaza con firma inválida", async () => {
    const body = JSON.stringify(eventoWhatsapp(ACCOUNT_ID));
    const res = await request(app)
      .post("/webhooks/zernio")
      .set("Content-Type", "application/json")
      .set("x-zernio-signature", "0".repeat(64))
      .send(body);
    expect(res.status).toBe(400);
  });

  it("acepta con firma válida y encola el evento", async () => {
    const evento = eventoWhatsapp(ACCOUNT_ID);
    const body = JSON.stringify(evento);
    const res = await request(app)
      .post("/webhooks/zernio")
      .set("Content-Type", "application/json")
      .set("x-zernio-signature", firmar(body))
      .send(body);
    expect(res.status).toBe(200);

    const fila = await adminDb().channelWebhookEvent.findUnique({
      where: { zernioEventId: evento.id }
    });
    expect(fila?.estado).toBe("pendiente");
  });

  it("la misma entrega repetida (at-least-once) no duplica el evento", async () => {
    const evento = eventoWhatsapp(ACCOUNT_ID);
    const body = JSON.stringify(evento);
    const firma = firmar(body);

    const primera = await request(app)
      .post("/webhooks/zernio")
      .set("Content-Type", "application/json")
      .set("x-zernio-signature", firma)
      .send(body);
    const segunda = await request(app)
      .post("/webhooks/zernio")
      .set("Content-Type", "application/json")
      .set("x-zernio-signature", firma)
      .send(body);

    expect(primera.status).toBe(200);
    expect(segunda.status).toBe(200);

    const count = await adminDb().channelWebhookEvent.count({
      where: { zernioEventId: evento.id }
    });
    expect(count).toBe(1);
  });

  it("el worker resuelve el tenant y despierta a n8n con el evento crudo + tenant_id", async () => {
    // Drena lo que hayan dejado pendiente los tests anteriores (encolaron
    // eventos pero no los procesaron) — así el conteo de abajo es exacto.
    while ((await processChannelEventsOnce(yaSeEnfrio())) > 0) {
      /* flush */
    }
    n8nRequests.length = 0;

    const evento = eventoWhatsapp(ACCOUNT_ID);
    const body = JSON.stringify(evento);
    await request(app)
      .post("/webhooks/zernio")
      .set("Content-Type", "application/json")
      .set("x-zernio-signature", firmar(body))
      .send(body);

    const procesados = await processChannelEventsOnce(yaSeEnfrio());
    expect(procesados).toBe(1);

    const pendientes = await adminDb().channelWebhookEvent.count({ where: { estado: "pendiente" } });
    expect(pendientes).toBe(0);

    expect(n8nRequests).toHaveLength(1);
    const recibido = JSON.parse(n8nRequests[0]!.body);
    expect(recibido.tenant_id).toBe(A.tenant.id);
    expect(recibido.canal).toBe("whatsapp");
    expect(recibido.channel_account_id).toBe(channelAccountId);
    expect(recibido.zernio_account_id).toBe(ACCOUNT_ID);
    expect(recibido.provider_conversation_id).toBe(evento.message.conversationId);
    // Mismo formato batch que mandaba Kapso: el nodo `normalizar` de n8n lee
    // una lista, aunque traiga un solo mensaje.
    expect(recibido.data).toHaveLength(1);
    expect(recibido.data[0].id).toBe(evento.id);
    expect(recibido.data[0].event).toBe("message.received");
    expect(recibido.data[0].message.sender.phoneNumber).toBe("+5493810000099");

    // Este worker no escribe leads/conversations — eso lo sigue haciendo n8n
    // (abrir_conversacion/registrar_entrante) para no duplicar el registro.
    const lead = await adminDb().lead.findFirst({
      where: { tenantId: A.tenant.id, canal: "whatsapp", canalRef: "+5493810000099" }
    });
    expect(lead).toBeNull();
  });

  it("registra message.sent de WhatsApp Business sin despertar al agente", async () => {
    while ((await processChannelEventsOnce(yaSeEnfrio())) > 0) {
      /* flush */
    }
    n8nRequests.length = 0;

    const evento = eventoWhatsappSaliente(ACCOUNT_ID);
    const body = JSON.stringify(evento);
    const recibido = await request(app)
      .post("/webhooks/zernio")
      .set("Content-Type", "application/json")
      .set("x-zernio-signature", firmar(body))
      .send(body);

    expect(recibido.status).toBe(200);
    expect(await processChannelEventsOnce(yaSeEnfrio())).toBe(1);

    const fila = await adminDb().channelWebhookEvent.findUniqueOrThrow({
      where: { zernioEventId: evento.id }
    });
    expect(fila.evento).toBe("message.sent");
    expect(fila.estado).toBe("procesado");
    expect(fila.errorDetalle).toBeNull();
    expect(n8nRequests).toHaveLength(0);
  });

  it("registra la intervención humana, toma el lead y silencia el bot de forma idempotente", async () => {
    while ((await processChannelEventsOnce(yaSeEnfrio())) > 0) {
      /* flush */
    }
    n8nRequests.length = 0;

    const lead = await adminDb().lead.create({
      data: {
        tenantId: A.tenant.id,
        canal: "whatsapp",
        canalRef: "5493812223344",
        nombre: "Intervención coexistence",
        telefono: "+5493812223344",
        mensaje: "Consulta previa"
      }
    });
    const conversation = await adminDb().conversation.create({
      data: {
        tenantId: A.tenant.id,
        leadId: lead.id,
        canal: "whatsapp",
        canalRef: "5493812223344",
        channelAccountId,
        providerConversationId: "conv_toma_business_app"
      }
    });
    const handoff = await adminDb().handoff.create({
      data: {
        tenantId: A.tenant.id,
        conversationId: conversation.id,
        vendedorId: A.agente.id,
        motivo: "pedido_humano"
      }
    });

    const evento = eventoWhatsappSaliente(ACCOUNT_ID, {
      conversationId: "conv_toma_business_app",
      participantId: "5493812223344",
      text: "Hola, soy de Lamelas. Te ayudo por acá."
    });
    const body = JSON.stringify(evento);
    await request(app)
      .post("/webhooks/zernio")
      .set("Content-Type", "application/json")
      .set("x-zernio-signature", firmar(body))
      .send(body);

    expect(await processChannelEventsOnce(yaSeEnfrio())).toBe(1);
    expect(n8nRequests).toHaveLength(0);

    const [updatedConversation, updatedLead, updatedHandoff, messages] = await Promise.all([
      adminDb().conversation.findUniqueOrThrow({ where: { id: conversation.id } }),
      adminDb().lead.findUniqueOrThrow({ where: { id: lead.id } }),
      adminDb().handoff.findUniqueOrThrow({ where: { id: handoff.id } }),
      adminDb().conversationMessage.findMany({ where: { conversationId: conversation.id } })
    ]);
    expect(updatedConversation.estado).toBe("humano");
    expect(updatedLead.tomadoAt).toBeInstanceOf(Date);
    expect(updatedLead.tomadoPor).toBeNull();
    expect(updatedLead.tomadoOrigen).toBe("whatsapp_business_app");
    expect(updatedHandoff.resultado).toBe("tomado");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      rol: "vendedor",
      contenido: "Hola, soy de Lamelas. Te ayudo por acá.",
      providerMessageId: evento.message.id
    });

    // Simula un crash posterior a la transacción de negocio pero anterior al
    // marcado del evento: el reintento no duplica el mensaje.
    await adminDb().channelWebhookEvent.update({
      where: { zernioEventId: evento.id },
      data: { estado: "pendiente", procesadoAt: null }
    });
    expect(await processChannelEventsOnce(yaSeEnfrio())).toBe(1);
    expect(
      await adminDb().conversationMessage.count({ where: { conversationId: conversation.id } })
    ).toBe(1);
  });

  it("message.sent de cloud_api no toma el chat ni se entrega al agente", async () => {
    n8nRequests.length = 0;
    const lead = await adminDb().lead.create({
      data: {
        tenantId: A.tenant.id,
        canal: "whatsapp",
        canalRef: "5493815556677",
        nombre: "Salida de Sofi",
        mensaje: "Hola"
      }
    });
    const conversation = await adminDb().conversation.create({
      data: {
        tenantId: A.tenant.id,
        leadId: lead.id,
        canal: "whatsapp",
        canalRef: "5493815556677",
        channelAccountId,
        providerConversationId: "conv_cloud_api"
      }
    });
    const evento = eventoWhatsappSaliente(ACCOUNT_ID, {
      conversationId: "conv_cloud_api",
      source: "cloud_api"
    });
    const body = JSON.stringify(evento);
    await request(app)
      .post("/webhooks/zernio")
      .set("Content-Type", "application/json")
      .set("x-zernio-signature", firmar(body))
      .send(body);

    expect(await processChannelEventsOnce(yaSeEnfrio())).toBe(1);
    expect(n8nRequests).toHaveLength(0);
    expect(
      (await adminDb().conversation.findUniqueOrThrow({ where: { id: conversation.id } })).estado
    ).toBe("bot");
    expect((await adminDb().lead.findUniqueOrThrow({ where: { id: lead.id } })).tomadoAt).toBeNull();
    expect(
      await adminDb().conversationMessage.count({ where: { conversationId: conversation.id } })
    ).toBe(0);
  });

  it("una respuesta desde la app silencia el bot sin sobrescribir una toma anterior", async () => {
    const firstTakenAt = new Date("2026-08-28T18:00:00.000Z");
    const lead = await adminDb().lead.create({
      data: {
        tenantId: A.tenant.id,
        assignedTo: A.admin.id,
        canal: "whatsapp",
        canalRef: "5493817778899",
        nombre: "Retomado desde la app",
        mensaje: "Consulta",
        tomadoAt: firstTakenAt,
        tomadoPor: A.admin.id,
        tomadoOrigen: "panel"
      }
    });
    const conversation = await adminDb().conversation.create({
      data: {
        tenantId: A.tenant.id,
        leadId: lead.id,
        canal: "whatsapp",
        canalRef: "5493817778899",
        channelAccountId,
        providerConversationId: "conv_retomada_business_app",
        estado: "bot"
      }
    });
    const evento = eventoWhatsappSaliente(ACCOUNT_ID, {
      conversationId: "conv_retomada_business_app",
      participantId: "5493817778899"
    });
    const body = JSON.stringify(evento);
    await request(app)
      .post("/webhooks/zernio")
      .set("Content-Type", "application/json")
      .set("x-zernio-signature", firmar(body))
      .send(body);

    expect(await processChannelEventsOnce(yaSeEnfrio())).toBe(1);
    const [updatedConversation, updatedLead] = await Promise.all([
      adminDb().conversation.findUniqueOrThrow({ where: { id: conversation.id } }),
      adminDb().lead.findUniqueOrThrow({ where: { id: lead.id } })
    ]);
    expect(updatedConversation.estado).toBe("humano");
    expect(updatedLead.tomadoAt?.toISOString()).toBe(firstTakenAt.toISOString());
    expect(updatedLead.tomadoPor).toBe(A.admin.id);
    expect(updatedLead.tomadoOrigen).toBe("panel");
  });

  it("si n8n no responde 2xx, el evento se reintenta (transitorio, no permanente)", async () => {
    n8nRespondWith = 500;
    const evento = eventoWhatsapp(ACCOUNT_ID);
    const body = JSON.stringify(evento);
    await request(app)
      .post("/webhooks/zernio")
      .set("Content-Type", "application/json")
      .set("x-zernio-signature", firmar(body))
      .send(body);

    await processChannelEventsOnce(yaSeEnfrio());
    const fila = await adminDb().channelWebhookEvent.findUnique({
      where: { zernioEventId: evento.id }
    });
    expect(fila?.estado).toBe("pendiente"); // no 'error': todavía tiene reintentos disponibles
    expect(fila?.intentos).toBe(1);

    n8nRespondWith = 200;
    await processChannelEventsOnce(yaSeEnfrio());
    const reintentada = await adminDb().channelWebhookEvent.findUnique({
      where: { zernioEventId: evento.id }
    });
    expect(reintentada?.estado).toBe("procesado");
    expect(reintentada?.errorDetalle).toBeNull();
  });

  it("un evento de una cuenta desconocida queda en error, sin reintentar en loop", async () => {
    const evento = eventoWhatsapp("acc_no_existe");
    const body = JSON.stringify(evento);
    await request(app)
      .post("/webhooks/zernio")
      .set("Content-Type", "application/json")
      .set("x-zernio-signature", firmar(body))
      .send(body);

    await processChannelEventsOnce(yaSeEnfrio());
    const fila = await adminDb().channelWebhookEvent.findUnique({
      where: { zernioEventId: evento.id }
    });
    expect(fila?.estado).toBe("error");

    // No vuelve a aparecer como pendiente en la siguiente pasada.
    const procesadosOtraVez = await processChannelEventsOnce(yaSeEnfrio());
    expect(procesadosOtraVez).toBe(0);
  });

  it("un tenant suspendido no dispara el agente ni reintenta eventos antiguos al reactivarse", async () => {
    while ((await processChannelEventsOnce(yaSeEnfrio())) > 0) {
      /* drenar eventos anteriores */
    }
    n8nRequests.length = 0;
    const evento = eventoWhatsapp(ACCOUNT_ID, { conversationId: "conv_suspended" });
    const body = JSON.stringify(evento);
    const response = await request(app)
      .post("/webhooks/zernio")
      .set("Content-Type", "application/json")
      .set("x-zernio-signature", firmar(body))
      .send(body);
    expect(response.status).toBe(200);

    await adminDb().tenant.update({ where: { id: A.tenant.id }, data: { estado: "suspendido" } });
    try {
      await processChannelEventsOnce(yaSeEnfrio());
      expect(n8nRequests).toHaveLength(0);
      const stored = await adminDb().channelWebhookEvent.findUniqueOrThrow({
        where: { zernioEventId: evento.id }
      });
      expect(stored.estado).toBe("error");
      expect(stored.errorDetalle).toBe("inmobiliaria suspendida");
    } finally {
      await adminDb().tenant.update({ where: { id: A.tenant.id }, data: { estado: "activo" } });
    }
    expect(await processChannelEventsOnce(yaSeEnfrio())).toBe(0);
    expect(n8nRequests).toHaveLength(0);
  });

  // ── Buffer de ráfagas ──────────────────────────────────────────────────────
  // Zernio manda un webhook por mensaje; el worker los junta por conversación
  // para que Sofi conteste una vez por turno y no una vez por mensaje.

  async function drenar() {
    while ((await processChannelEventsOnce(yaSeEnfrio())) > 0) {
      /* flush */
    }
    n8nRequests.length = 0;
  }

  async function encolar(evento: ReturnType<typeof eventoWhatsapp>) {
    const body = JSON.stringify(evento);
    await request(app)
      .post("/webhooks/zernio")
      .set("Content-Type", "application/json")
      .set("x-zernio-signature", firmar(body))
      .send(body);
    return evento;
  }

  it("dos workers no despachan la misma ráfaga mientras el primer POST sigue abierto", async () => {
    await drenar();
    const firstEvent = await encolar(eventoWhatsapp(ACCOUNT_ID, { conversationId: "conv_claim_parallel", text: "hola" }));
    const secondEvent = await encolar(eventoWhatsapp(ACCOUNT_ID, { conversationId: "conv_claim_parallel", text: "busco casa" }));
    let release: (() => void) | undefined;
    n8nResponseGate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const first = processChannelEventsOnce(yaSeEnfrio());
      await vi.waitFor(() => expect(n8nRequests).toHaveLength(1));
      expect(await processChannelEventsOnce(yaSeEnfrio())).toBe(0);
      expect(n8nRequests).toHaveLength(1);
      release!();
      expect(await first).toBe(2);
      const events = await adminDb().channelWebhookEvent.findMany({
        where: { zernioEventId: { in: [firstEvent.id, secondEvent.id] } }
      });
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.estado === "procesado" && event.claimId === null)).toBe(true);
    } finally {
      release?.();
      n8nResponseGate = null;
    }
  });

  it("un claim parcial no divide la ráfaga; al vencer se recupera completa", async () => {
    await drenar();
    const first = await encolar(eventoWhatsapp(ACCOUNT_ID, {
      conversationId: "conv_claim_partial", text: "primero"
    }));
    await encolar(eventoWhatsapp(ACCOUNT_ID, {
      conversationId: "conv_claim_partial", text: "segundo"
    }));
    await adminDb().channelWebhookEvent.update({
      where: { zernioEventId: first.id },
      data: { claimId: randomUUID(), claimedAt: new Date() }
    });

    expect(await processChannelEventsOnce(yaSeEnfrio())).toBe(0);
    expect(n8nRequests).toHaveLength(0);
    const unclaimed = await adminDb().channelWebhookEvent.findMany({
      where: { estado: "pendiente", claimId: null }
    });
    expect(unclaimed).toHaveLength(1);

    await adminDb().channelWebhookEvent.update({
      where: { zernioEventId: first.id },
      data: { claimedAt: new Date(Date.now() - 120_000) }
    });
    expect(await processChannelEventsOnce(yaSeEnfrio())).toBe(2);
    expect(n8nRequests).toHaveLength(1);
    expect(JSON.parse(n8nRequests[0]!.body).data).toHaveLength(2);
  });

  it("agrupa la ráfaga de una conversación en un solo POST a n8n", async () => {
    await drenar();

    for (const text of ["hola", "busco depto", "en yerba buena"]) {
      await encolar(eventoWhatsapp(ACCOUNT_ID, { conversationId: "conv_rafaga", text }));
    }

    expect(await processChannelEventsOnce(yaSeEnfrio())).toBe(3);
    expect(n8nRequests).toHaveLength(1);

    const recibido = JSON.parse(n8nRequests[0]!.body);
    expect(recibido.data).toHaveLength(3);
    expect(recibido.data.map((e: { message: { text: string } }) => e.message.text)).toEqual([
      "hola",
      "busco depto",
      "en yerba buena"
    ]);
  });

  it("no despacha la ráfaga mientras el lead sigue escribiendo", async () => {
    await drenar();

    const evento = await encolar(
      eventoWhatsapp(ACCOUNT_ID, { conversationId: "conv_caliente" })
    );

    // Con el reloj real el evento se acaba de encolar: sigue dentro de la
    // ventana de silencio, así que no sale.
    expect(await processChannelEventsOnce()).toBe(0);
    expect(n8nRequests).toHaveLength(0);

    const fila = await adminDb().channelWebhookEvent.findUnique({
      where: { zernioEventId: evento.id }
    });
    expect(fila?.estado).toBe("pendiente");
    // Esperar no es fallar: el contador de reintentos no se toca.
    expect(fila?.intentos).toBe(0);

    expect(await processChannelEventsOnce(yaSeEnfrio())).toBe(1);
    expect(n8nRequests).toHaveLength(1);
  });

  it("un mensaje nuevo mantiene caliente a toda la ráfaga", async () => {
    await drenar();

    // El primero llegó hace rato (se inserta con fecha vieja, para no depender
    // del reloj de la corrida); el segundo recién entra. El grupo ENTERO tiene
    // que esperar: partirlo mandaría el primer mensaje solo y Sofi contestaría
    // con contexto incompleto.
    const viejo = eventoWhatsapp(ACCOUNT_ID, { conversationId: "conv_mixta", text: "hola" });
    await adminDb().channelWebhookEvent.create({
      data: {
        zernioEventId: viejo.id,
        evento: viejo.event,
        payload: viejo,
        recibidoAt: new Date(Date.now() - 60_000)
      }
    });
    await encolar(eventoWhatsapp(ACCOUNT_ID, { conversationId: "conv_mixta", text: "che" }));

    expect(await processChannelEventsOnce()).toBe(0);
    expect(n8nRequests).toHaveLength(0);

    // Cuando se enfría, salen los dos juntos y en orden de llegada.
    expect(await processChannelEventsOnce(yaSeEnfrio())).toBe(2);
    expect(n8nRequests).toHaveLength(1);
    const recibido = JSON.parse(n8nRequests[0]!.body);
    expect(recibido.data.map((e: { message: { text: string } }) => e.message.text)).toEqual([
      "hola",
      "che"
    ]);
  });

  it("dos conversaciones en paralelo salen en POSTs separados", async () => {
    await drenar();

    await encolar(eventoWhatsapp(ACCOUNT_ID, { conversationId: "conv_x", text: "soy X" }));
    await encolar(eventoWhatsapp(ACCOUNT_ID, { conversationId: "conv_y", text: "soy Y" }));

    expect(await processChannelEventsOnce(yaSeEnfrio())).toBe(2);
    expect(n8nRequests).toHaveLength(2);

    const textos = n8nRequests
      .map((r) => JSON.parse(r.body).data.map((e: { message: { text: string } }) => e.message.text))
      .flat()
      .sort();
    expect(textos).toEqual(["soy X", "soy Y"]);
  });
});
