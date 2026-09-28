import { beforeEach, describe, expect, it, vi } from "vitest";
import { processFollowupsOnce } from "../src/modules/agent/followup.worker.js";
import {
  abrirConversacion,
  procesarVencidos,
  registrarMensajes
} from "../src/modules/agent/service.js";
import { updateLead } from "../src/modules/crm/service.js";
import { currentTenant, updateCurrentTenant } from "../src/modules/tenants/service.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Seguimiento automático de WhatsApp", () => {
  let seeded: Awaited<ReturnType<typeof seedTenantWithUsers>>;

  beforeEach(async () => {
    await truncateAll();
    seeded = await seedTenantWithUsers("followups");
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
