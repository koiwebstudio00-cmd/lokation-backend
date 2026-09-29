import { beforeEach, describe, expect, it, vi } from "vitest";
import { processFollowupsOnce } from "../src/modules/agent/followup.worker.js";
import {
  abrirConversacion,
  procesarVencidos,
  registrarMensajes
} from "../src/modules/agent/service.js";
import { updateLead } from "../src/modules/crm/service.js";
import { runWithContext } from "../src/lib/prisma.js";
import { currentTenant, setTenantEstado, updateCurrentTenant } from "../src/modules/tenants/service.js";
import { adminDb, DB_AVAILABLE, seedSuperAdmin, seedTenantWithUsers, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Seguimiento automático de WhatsApp", () => {
  let seeded: Awaited<ReturnType<typeof seedTenantWithUsers>>;

  beforeEach(async () => {
    await truncateAll();
    seeded = await seedTenantWithUsers("followups");
    await adminDb().tenant.update({
      where: { id: seeded.tenant.id },
      data: { agentEnabled: true }
    });
  });

  async function conversationFixture() {
    const channel = await adminDb().channelAccount.create({
      data: {
        tenantId: seeded.tenant.id,
        canal: "whatsapp",
        zernioProfileId: "profile_followups",
        zernioAccountId: "account_followups",
        conectadaPor: seeded.admin.id
      }
    });
    const lead = await adminDb().lead.create({
      data: {
        tenantId: seeded.tenant.id,
        canal: "whatsapp",
        canalRef: "5493811110000",
        nombre: "Lead silencioso",
        mensaje: "Hola, consulto por una propiedad"
      }
    });
    const conversation = await adminDb().conversation.create({
      data: {
        tenantId: seeded.tenant.id,
        leadId: lead.id,
        canal: "whatsapp",
        canalRef: "5493811110000",
        channelAccountId: channel.id,
        providerConversationId: "provider_followups"
      }
    });
    return { channel, lead, conversation };
  }

  it("suspender cancela seguimientos y reactivar no envía mensajes atrasados", async () => {
    const { conversation } = await conversationFixture();
    const dueAt = new Date("2026-09-14T10:00:00.000Z");
    await adminDb().conversation.update({
      where: { id: conversation.id },
      data: { followupStep: 1, followupDueAt: dueAt, lastLeadMessageAt: dueAt }
    });
    const operator = { userId: (await seedSuperAdmin()).id, rol: "super_admin" as const };
    const send = vi.fn(async () => ({ id: "should-not-send" }));

    await setTenantEstado(operator, seeded.tenant.id, "suspendido");
    const cancelled = await adminDb().conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(cancelled.followupStep).toBe(0);
    expect(cancelled.followupDueAt).toBeNull();
    expect(cancelled.followupClaimedAt).toBeNull();
    await processFollowupsOnce({ now: dueAt, send });
    expect(send).not.toHaveBeenCalled();

    await setTenantEstado(operator, seeded.tenant.id, "activo");
    await processFollowupsOnce({ now: dueAt, send });
    expect(send).not.toHaveBeenCalled();
  });

  it("agenda a las 2 horas, envía dos mensajes y asigna el fantasma sin reasignación", async () => {
    const { channel, lead, conversation } = await conversationFixture();
    await registrarMensajes(seeded.tenant.id, conversation.id, [
      { rol: "lead", contenido: "¿Sigue disponible?" }
    ]);

    vi.useFakeTimers();
    const answeredAt = new Date("2026-09-14T21:00:00.000Z");
    vi.setSystemTime(answeredAt);
    await registrarMensajes(seeded.tenant.id, conversation.id, [
      { rol: "agente_ia", contenido: "Sí, sigue disponible." }
    ]);
    vi.useRealTimers();

    let stored = await adminDb().conversation.findUniqueOrThrow({
      where: { id: conversation.id }
    });
    expect(stored.followupStep).toBe(1);
    expect(stored.followupDueAt?.toISOString()).toBe("2026-09-14T23:00:00.000Z");

    const sent: string[] = [];
    const send = vi.fn(async (input: { accountId: string; message: string }) => {
      expect(input.accountId).toBe(channel.zernioAccountId);
      sent.push(input.message);
      return { id: `followup-${sent.length}` };
    });

    await processFollowupsOnce({ now: new Date("2026-09-14T23:00:00.000Z"), send });
    stored = await adminDb().conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(stored.followupStep).toBe(2);
    expect(stored.followupDueAt?.toISOString()).toBe("2026-09-15T01:00:00.000Z");

    await processFollowupsOnce({ now: new Date("2026-09-15T01:00:00.000Z"), send });
    stored = await adminDb().conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(stored.followupStep).toBe(3);
    expect(stored.followupDueAt?.toISOString()).toBe("2026-09-15T03:00:00.000Z");
    expect(sent).toEqual([
      "Hola, ¿seguís interesado/a en la propiedad? Si querés te ayudo con cualquier duda.",
      "Te escribo por última vez por tu consulta. Si todavía te interesa, respondeme por acá y seguimos."
    ]);

    await processFollowupsOnce({ now: new Date("2026-09-15T03:00:00.000Z"), send });
    const finalLead = await adminDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    const finalConversation = await adminDb().conversation.findUniqueOrThrow({
      where: { id: conversation.id }
    });
    const handoff = await adminDb().handoff.findFirstOrThrow({
      where: { conversationId: conversation.id }
    });
    expect(finalLead.clasificacion).toBe("fantasma");
    expect(finalLead.assignedTo).toBe(seeded.agente.id);
    expect(finalConversation.estado).toBe("esperando_humano");
    expect(finalConversation.followupStep).toBe(0);
    expect(handoff.motivo).toBe("seguimiento_sin_respuesta");
    expect(handoff.reassignable).toBe(false);

    await adminDb().handoff.update({
      where: { id: handoff.id },
      data: { asignadoAt: new Date("2026-01-01T00:00:00.000Z") }
    });
    const timeout = await procesarVencidos(seeded.tenant.id);
    expect(timeout.revisados).toBe(0);
    expect(timeout.reasignados).toHaveLength(0);
  });

  it("un reintento de mensajes no reinicia ni cancela el seguimiento", async () => {
    const { conversation } = await conversationFixture();
    const lead = { rol: "lead" as const, contenido: "¿Sigue disponible?", providerMessageId: "in-1" };
    const agent = { rol: "agente_ia" as const, contenido: "Sí, sigue disponible.", providerMessageId: "out-1" };
    const first = await registrarMensajes(seeded.tenant.id, conversation.id, [lead, agent]);
    expect(first.creados).toBe(2);
    const before = await adminDb().conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(before.followupStep).toBe(1);

    const retry = await registrarMensajes(seeded.tenant.id, conversation.id, [lead, agent]);
    expect(retry.creados).toBe(0);
    const after = await adminDb().conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(after.followupStep).toBe(1);
    expect(after.followupDueAt?.getTime()).toBe(before.followupDueAt?.getTime());
    expect(after.lastLeadMessageAt?.getTime()).toBe(before.lastLeadMessageAt?.getTime());

    const mixed = await registrarMensajes(seeded.tenant.id, conversation.id, [
      lead,
      { ...agent, providerMessageId: "out-2", contenido: "También puedo mostrarte fotos." }
    ]);
    expect(mixed.creados).toBe(1);
    const afterMixed = await adminDb().conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(afterMixed.followupStep).toBe(1);
    expect(afterMixed.followupDueAt!.getTime()).toBeGreaterThanOrEqual(before.followupDueAt!.getTime());
    expect(afterMixed.lastLeadMessageAt?.getTime()).toBe(before.lastLeadMessageAt?.getTime());
    expect(await adminDb().conversationMessage.count({ where: { conversationId: conversation.id } })).toBe(3);
  });

  it("un envío de resultado incierto no se reenvía automáticamente", async () => {
    const { conversation } = await conversationFixture();
    const leadAt = new Date("2026-09-14T19:00:00.000Z");
    const dueAt = new Date("2026-09-14T21:00:00.000Z");
    await adminDb().conversation.update({
      where: { id: conversation.id },
      data: { followupStep: 1, followupDueAt: dueAt, lastLeadMessageAt: leadAt }
    });
    const send = vi.fn(async () => { throw new Error("timeout después de enviar"); });
    await processFollowupsOnce({ now: dueAt, send });
    const attempt = await adminDb().outboundMessageAttempt.findFirstOrThrow({
      where: { conversationId: conversation.id }
    });
    expect(attempt.status).toBe("uncertain");
    expect(attempt.operationKey).toContain(conversation.id);
    expect((await adminDb().conversation.findUniqueOrThrow({ where: { id: conversation.id } })).followupStep).toBe(0);

    await processFollowupsOnce({ now: new Date("2026-09-14T22:00:00.000Z"), send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await adminDb().conversationMessage.count({ where: { conversationId: conversation.id } })).toBe(0);
  });

  it("completa un envío ya confirmado sin volver a llamar a Zernio", async () => {
    const { conversation } = await conversationFixture();
    const leadAt = new Date("2026-09-14T19:00:00.000Z");
    const dueAt = new Date("2026-09-14T21:00:00.000Z");
    await adminDb().conversation.update({
      where: { id: conversation.id },
      data: { followupStep: 1, followupDueAt: dueAt, lastLeadMessageAt: leadAt }
    });
    await adminDb().outboundMessageAttempt.create({ data: {
      tenantId: seeded.tenant.id,
      conversationId: conversation.id,
      operationKey: `followup:${conversation.id}:${leadAt.toISOString()}:1`,
      content: "¿Seguís buscando?",
      status: "sent",
      providerMessageId: "zernio-confirmed"
    } });
    const send = vi.fn(async () => ({ id: "duplicado" }));
    await processFollowupsOnce({ now: dueAt, send });
    expect(send).not.toHaveBeenCalled();
    const stored = await adminDb().conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(stored.followupStep).toBe(2);
    const messages = await adminDb().conversationMessage.findMany({ where: { conversationId: conversation.id } });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.providerMessageId).toBe("zernio-confirmed");
    expect(messages[0]?.contenido).toBe("¿Seguís buscando?");
  });

  it("la política de intentos rechaza atribuir un envío a otra inmobiliaria", async () => {
    const { conversation } = await conversationFixture();
    const other = await seedTenantWithUsers("followups-other");
    await expect(runWithContext({ rol: "worker" }, (tx) =>
      tx.outboundMessageAttempt.create({ data: {
        tenantId: other.tenant.id,
        conversationId: conversation.id,
        operationKey: "wrong-tenant",
        content: "mensaje ajeno"
      } })
    )).rejects.toThrow();
    expect(await adminDb().outboundMessageAttempt.count()).toBe(0);
  });

  it("una respuesta del lead cancela inmediatamente los seguimientos", async () => {
    const { conversation } = await conversationFixture();
    await registrarMensajes(seeded.tenant.id, conversation.id, [
      { rol: "agente_ia", contenido: "¿En qué te ayudo?" }
    ]);
    await registrarMensajes(seeded.tenant.id, conversation.id, [
      { rol: "lead", contenido: "Sí, me interesa" }
    ]);

    const stored = await adminDb().conversation.findUniqueOrThrow({
      where: { id: conversation.id }
    });
    expect(stored.followupStep).toBe(0);
    expect(stored.followupDueAt).toBeNull();
    expect(stored.followupClaimedAt).toBeNull();
  });

  it("la marca manual fantasma silencia a Sofi sin asignar vendedor", async () => {
    const { lead, conversation } = await conversationFixture();
    await registrarMensajes(seeded.tenant.id, conversation.id, [
      { rol: "agente_ia", contenido: "¿Seguís ahí?" }
    ]);

    await updateLead(
      { userId: seeded.admin.id, tenantId: seeded.tenant.id, rol: "admin" },
      lead.id,
      { clasificacion: "fantasma" }
    );

    const finalLead = await adminDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    const finalConversation = await adminDb().conversation.findUniqueOrThrow({
      where: { id: conversation.id }
    });
    expect(finalLead.assignedTo).toBeNull();
    expect(finalConversation.vendedorId).toBeNull();
    expect(finalConversation.estado).toBe("humano");
    expect(finalConversation.followupStep).toBe(0);
    expect(await adminDb().handoff.count({ where: { conversationId: conversation.id } })).toBe(0);
  });

  it("el admin edita textos de su tenant y el worker usa el valor nuevo", async () => {
    const auth = { userId: seeded.admin.id, tenantId: seeded.tenant.id, rol: "admin" as const };
    await updateCurrentTenant(auth, {
      followupEnabled: true,
      followupFirstMessage: "Mensaje configurable uno",
      followupSecondMessage: "Mensaje configurable dos"
    });
    const tenant = await currentTenant(auth);
    expect(tenant.followupFirstMessage).toBe("Mensaje configurable uno");

    const { conversation } = await conversationFixture();
    const now = new Date("2026-09-14T10:00:00.000Z");
    await adminDb().conversation.update({
      where: { id: conversation.id },
      data: { followupStep: 1, followupDueAt: now, lastLeadMessageAt: now }
    });
    const send = vi.fn(async () => ({ id: "custom-message" }));
    await processFollowupsOnce({ now, send });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ message: "Mensaje configurable uno" }));
  });

  it("dos pasadas concurrentes reclaman una etapa una sola vez", async () => {
    const { conversation } = await conversationFixture();
    const now = new Date("2026-09-14T10:00:00.000Z");
    await adminDb().conversation.update({
      where: { id: conversation.id },
      data: { followupStep: 1, followupDueAt: now, lastLeadMessageAt: now }
    });
    const send = vi.fn(async () => ({ id: "only-once" }));

    await Promise.all([
      processFollowupsOnce({ now, send }),
      processFollowupsOnce({ now, send })
    ]);

    expect(send).toHaveBeenCalledTimes(1);
    const messages = await adminDb().conversationMessage.findMany({
      where: { conversationId: conversation.id }
    });
    expect(messages).toHaveLength(1);
  });

  it("el interruptor global apaga todas las respuestas y cancela seguimientos", async () => {
    const { channel, conversation } = await conversationFixture();
    await registrarMensajes(seeded.tenant.id, conversation.id, [
      { rol: "agente_ia", contenido: "Respuesta antes de apagar" }
    ]);

    const auth = { userId: seeded.admin.id, tenantId: seeded.tenant.id, rol: "admin" as const };
    await updateCurrentTenant(auth, { agentEnabled: false });

    let stored = await adminDb().conversation.findUniqueOrThrow({
      where: { id: conversation.id }
    });
    expect(stored.estado).toBe("bot");
    expect(stored.followupStep).toBe(0);
    expect(stored.followupDueAt).toBeNull();

    const openedOff = await abrirConversacion(seeded.tenant.id, {
      canal: "whatsapp",
      canalRef: "5493811110000",
      channelAccountId: channel.id,
      providerConversationId: "provider_followups"
    });
    expect(openedOff.conversation.bot_activo).toBe(false);

    const whileOff = await registrarMensajes(seeded.tenant.id, conversation.id, [
      { rol: "agente_ia", contenido: "No debe abrir seguimiento" }
    ]);
    expect(whileOff.conversation.bot_activo).toBe(false);
    stored = await adminDb().conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(stored.followupStep).toBe(0);

    await updateCurrentTenant(auth, { agentEnabled: true });
    const openedOn = await abrirConversacion(seeded.tenant.id, {
      canal: "whatsapp",
      canalRef: "5493811110000",
      channelAccountId: channel.id,
      providerConversationId: "provider_followups"
    });
    expect(openedOn.conversation.bot_activo).toBe(true);
  });
});
