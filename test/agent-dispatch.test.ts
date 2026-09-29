import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { dispatchAgentMessage } from "../src/modules/agent/dispatch.service.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Despacho durable del agente", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let conversationId: string;

  beforeEach(async () => {
    await truncateAll();
    a = await seedTenantWithUsers("dispatch-a");
    b = await seedTenantWithUsers("dispatch-b");
    await adminDb().tenant.updateMany({
      where: { id: { in: [a.tenant.id, b.tenant.id] } },
      data: { agentEnabled: true }
    });
    const channel = await adminDb().channelAccount.create({ data: {
      tenantId: a.tenant.id,
      canal: "whatsapp",
      zernioProfileId: "dispatch-profile-a",
      zernioAccountId: "dispatch-account-a",
      conectadaPor: a.admin.id
    } });
    const lead = await adminDb().lead.create({ data: {
      tenantId: a.tenant.id, canal: "whatsapp", canalRef: "5493811239900",
      nombre: "Lead de prueba", mensaje: "Quiero consultar"
    } });
    const conversation = await adminDb().conversation.create({ data: {
      tenantId: a.tenant.id, leadId: lead.id, canal: "whatsapp", canalRef: lead.canalRef,
      channelAccountId: channel.id, providerConversationId: "zernio-conversation-a"
    } });
    conversationId = conversation.id;
  });

  const input = (tenantId: string, id: string) => ({
    tenantId, conversationId: id, operationKey: "turn-123:part-0", content: "Sí, está disponible."
  });

  it("envía una vez, registra el mensaje y devuelve el resultado guardado al repetir", async () => {
    const send = vi.fn(async (value: { accountId: string; providerConversationId: string; content: string; idempotencyKey: string }) => {
      expect(value.accountId).toBe("dispatch-account-a");
      expect(value.providerConversationId).toBe("zernio-conversation-a");
      expect(value.content).toBe("Sí, está disponible.");
      expect(value.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      return { message: { id: "zernio-out-1" } };
    });
    const first = await dispatchAgentMessage(input(a.tenant.id, conversationId), send);
    const retry = await dispatchAgentMessage(input(a.tenant.id, conversationId), send);
    expect(first.status).toBe("sent");
    expect(retry.status).toBe("replayed");
    expect(send).toHaveBeenCalledTimes(1);
    const stored = await adminDb().conversationMessage.findMany({ where: { conversationId } });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.providerMessageId).toBe("zernio-out-1");
    expect((await adminDb().conversation.findUniqueOrThrow({ where: { id: conversationId } })).followupStep).toBe(1);
    await expect(dispatchAgentMessage({ ...input(a.tenant.id, conversationId), content: "Otro texto" }, send))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("un timeout deja el resultado incierto y bloquea el reenvío", async () => {
    const send = vi.fn(async () => { throw new Error("timeout"); });
    await expect(dispatchAgentMessage(input(a.tenant.id, conversationId), send)).rejects.toThrow("timeout");
    await expect(dispatchAgentMessage(input(a.tenant.id, conversationId), send))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await adminDb().outboundMessageAttempt.findFirstOrThrow({ where: { conversationId } })).status)
      .toBe("uncertain");
    expect(await adminDb().conversationMessage.count({ where: { conversationId } })).toBe(0);
  });

  it("bloquea conversaciones humanas y admite sólo el aviso de un handoff pendiente", async () => {
    const send = vi.fn(async () => ({ id: "handoff-out" }));
    await adminDb().conversation.update({ where: { id: conversationId }, data: { estado: "humano" } });
    expect((await dispatchAgentMessage(input(a.tenant.id, conversationId), send)).status).toBe("cancelled");
    expect(send).not.toHaveBeenCalled();

    await adminDb().conversation.update({ where: { id: conversationId }, data: { estado: "esperando_humano" } });
    const handoff = await adminDb().handoff.create({ data: {
      tenantId: a.tenant.id, conversationId, vendedorId: a.agente.id, motivo: "visita"
    } });
    const notice = await dispatchAgentMessage({
      ...input(a.tenant.id, conversationId), operationKey: "turn-123:handoff-0",
      handoffId: handoff.id
    }, send);
    expect(notice.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect((await adminDb().conversation.findUniqueOrThrow({ where: { id: conversationId } })).followupStep).toBe(0);

    await adminDb().conversation.update({ where: { id: conversationId }, data: { estado: "humano" } });
    expect((await dispatchAgentMessage({
      ...input(a.tenant.id, conversationId), operationKey: "turn-124:handoff-0", handoffId: handoff.id
    }, send)).status).toBe("cancelled");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("la API key de otra inmobiliaria no puede despachar en esta conversación", async () => {
    const browser = request.agent(app);
    const login = await browser.post("/v1/auth/login")
      .send({ email: b.admin.email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
    const key = await browser.post("/v1/integrations/api-keys")
      .set("x-csrf-token", login.body.csrf_token)
      .send({ nombre: "despacho B", scopes: ["agent:write"] });
    expect(key.status).toBe(201);
    const send = vi.spyOn(globalThis, "fetch");
    const response = await request(app)
      .post(`/v1/agent/conversations/${conversationId}/send`)
      .set("x-api-key", key.body.key)
      .send({ operation_key: "turn-123:part-0", contenido: "Mensaje ajeno" });
    expect(response.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
    expect(await adminDb().outboundMessageAttempt.count()).toBe(0);
  });

  it("el endpoint envía a Zernio con la clave durable y responde el replay", async () => {
    const browser = request.agent(app);
    const login = await browser.post("/v1/auth/login")
      .send({ email: a.admin.email, password: TEST_PASSWORD });
    const key = await browser.post("/v1/integrations/api-keys")
      .set("x-csrf-token", login.body.csrf_token)
      .send({ nombre: "despacho A", scopes: ["agent:write"] });
    expect(key.status).toBe(201);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: { id: "zernio-http-1" } }),
        { status: 200, headers: { "Content-Type": "application/json" } })
    );
    try {
      const path = `/v1/agent/conversations/${conversationId}/send`;
      const body = { operation_key: "turn-123:part-0", contenido: "Sí, está disponible." };
      const first = await request(app).post(path).set("x-api-key", key.body.key).send(body);
      const retry = await request(app).post(path).set("x-api-key", key.body.key).send(body);
      expect(first.status).toBe(200);
      expect(first.body.status).toBe("sent");
      expect(retry.body.status).toBe("replayed");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect((options.headers as Record<string, string>)["Idempotency-Key"])
        .toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
