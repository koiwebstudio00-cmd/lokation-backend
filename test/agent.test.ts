import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { minutosHabilesEntre } from "../src/lib/horario.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: ReturnType<typeof buildApp>, email: string) {
  const agent = request.agent(app);
  const res = await agent.post("/v1/auth/login").send({ email, password: TEST_PASSWORD });
  return { agent, csrf: res.body.csrf_token as string };
}

describe.runIf(DB_AVAILABLE)("Agente de IA", () => {
  const app = buildApp();
  let A: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let B: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let adminA: { agent: Agent; csrf: string };
  let keyAgente = "";
  let keyExport = "";
  let keyB = "";
  let propId = "";
  let convId = "";
  let leadId = "";

  beforeAll(async () => {
    await truncateAll();
    A = await seedTenantWithUsers("agnt");
    B = await seedTenantWithUsers("agnu");
    expect(A.tenant.agentEnabled).toBe(false);
    await adminDb().tenant.updateMany({
      where: { id: { in: [A.tenant.id, B.tenant.id] } },
      data: { agentEnabled: true }
    });
    adminA = await loginAgent(app, A.admin.email);

    // Propiedad con notas internas: el test anti-fuga se apoya en esto.
    const prop = await adminDb().property.create({
      data: {
        tenantId: A.tenant.id,
        userId: A.agente.id,
        titulo: "Departamento 2 dormitorios en Barrio Norte",
        operacion: "venta",
        tipo: "departamento",
        precio: 85000,
        moneda: "USD",
        zona: "Barrio Norte",
        ciudad: "San Miguel de Tucumán",
        dormitorios: 2,
        notas: "el dueño acepta hasta 78 mil",
        requisitos: "Garantia propietaria, recibo de sueldo y deposito de un mes"
      }
    });
    propId = prop.id;

    // Una vendida, que el agente nunca debería ofrecer.
    await adminDb().property.create({
      data: {
        tenantId: A.tenant.id,
        userId: A.agente.id,
        titulo: "Casa ya vendida",
        operacion: "venta",
        tipo: "casa",
        precio: 60000,
        estado: "vendida",
        ciudad: "San Miguel de Tucumán"
      }
    });

    const mk = async (nombre: string, scopes: string[], who = adminA) => {
      const res = await who.agent
        .post("/v1/integrations/api-keys")
        .set("x-csrf-token", who.csrf)
        .send({ nombre, scopes });
      return res.body.key as string;
    };
    keyAgente = await mk("n8n", ["agent:read", "agent:write"]);
    keyExport = await mk("sitio", ["export:read"]);

    const adminB = await loginAgent(app, B.admin.email);
    keyB = await mk("n8n B", ["agent:read", "agent:write"], adminB);
  });

  // ── Propiedades ────────────────────────────────────────────────────────────
  it("busca propiedades y NUNCA filtra las notas internas", async () => {
    const res = await request(app)
      .get("/v1/agent/properties?q=barrio norte")
      .set("x-api-key", keyAgente);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0].titulo).toContain("Barrio Norte");

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("notas");
    expect(raw).not.toContain("acepta hasta 78");
    expect(raw).not.toContain("userId");
    expect(raw).not.toContain("user_id");
    expect(raw).not.toContain("tenantId");
    // Los requisitos de alquiler SÍ son públicos: el agente los necesita.
    expect(res.body.data[0].requisitos).toContain("Garantia propietaria");
  });

  it("por defecto ofrece disponibles y privadas, pero no vendidas", async () => {
    // Una privada: NO se publica en la web, pero el agente SÍ la puede ofrecer.
    await adminDb().property.create({
      data: {
        tenantId: A.tenant.id,
        userId: A.agente.id,
        titulo: "Casa privada exclusiva",
        operacion: "venta",
        tipo: "casa",
        precio: 90000,
        estado: "privado",
        ciudad: "San Miguel de Tucumán"
      }
    });

    const res = await request(app).get("/v1/agent/properties").set("x-api-key", keyAgente);
    const titulos = res.body.data.map((p: { titulo: string }) => p.titulo);
    expect(titulos).not.toContain("Casa ya vendida");
    // La privada SÍ aparece en el default del agente.
    expect(titulos).toContain("Casa privada exclusiva");

    // El sitio público (export) NO la muestra: sigue pidiendo disponible.
    const web = await request(app)
      .get("/v1/export/properties?estado=disponible")
      .set("x-api-key", keyExport);
    const webTitulos = web.body.data.map((p: { titulo: string }) => p.titulo);
    expect(webTitulos).not.toContain("Casa privada exclusiva");

    // Pero se pueden pedir a propósito.
    const vendidas = await request(app)
      .get("/v1/agent/properties?estado=vendida")
      .set("x-api-key", keyAgente);
    expect(vendidas.body.meta.total).toBe(1);
  });

  it("ver_propiedad trae una propiedad por id, sin filtrar las notas internas", async () => {
    const res = await request(app)
      .get(`/v1/agent/properties/${propId}`)
      .set("x-api-key", keyAgente);
    expect(res.status).toBe(200);
    expect(res.body.property.id).toBe(propId);
    // `propId` se creó sin slug en el beforeAll, así que link_publico puede ser
    // null; el link/slug lo cubre el test por-slug de acá abajo.
    expect(res.body.property.titulo).toContain("Barrio Norte");

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("notas");
    expect(raw).not.toContain("acepta hasta 78");
    expect(raw).not.toContain("user_id");
    expect(raw).not.toContain("tenantId");
    expect(res.body.property.requisitos).toContain("Garantia propietaria");
  });

  it("ver_propiedad resuelve por slug y recupera una propiedad ya ofrecida", async () => {
    // Espeja el bug real: la dirección va en `direccion`, no en `zona`.
    const conSlug = await adminDb().property.create({
      data: {
        tenantId: A.tenant.id,
        userId: A.agente.id,
        titulo: "Monoambiente en Barrio Sur",
        operacion: "alquiler",
        tipo: "departamento",
        precio: 180000,
        moneda: "ARS",
        zona: "Barrio Sur",
        direccion: "Las Piedras 1239",
        ciudad: "San Miguel de Tucumán",
        slug: "alquiler-monoambiente-barrio-sur-test"
      }
    });
    const res = await request(app)
      .get(`/v1/agent/properties/${conSlug.slug}`)
      .set("x-api-key", keyAgente);
    expect(res.status).toBe(200);
    expect(res.body.property.id).toBe(conSlug.id);
    expect(res.body.property.direccion).toBe("Las Piedras 1239");
  });

  it("ver_propiedad da 404 si no existe y no cruza tenants", async () => {
    const noExiste = await request(app)
      .get("/v1/agent/properties/no-existe-este-slug")
      .set("x-api-key", keyAgente);
    expect(noExiste.status).toBe(404);

    const cruzado = await request(app)
      .get(`/v1/agent/properties/${propId}`)
      .set("x-api-key", keyB);
    expect(cruzado.status).toBe(404);
  });

  it("la key del sitio no entra al agente y viceversa", async () => {
    const sitio = await request(app).get("/v1/agent/properties").set("x-api-key", keyExport);
    expect(sitio.status).toBe(403);

    const agente = await request(app).get("/v1/export/properties").set("x-api-key", keyAgente);
    expect(agente.status).toBe(403);
  });

  // ── Conversación ───────────────────────────────────────────────────────────
  it("abre la conversación creando el lead, y es idempotente", async () => {
    const res = await request(app)
      .post("/v1/agent/conversations")
      .set("x-api-key", keyAgente)
      .send({
        canal: "whatsapp",
        canal_ref: "+5493815551234",
        nombre: "Marcela Gómez",
        property_id: propId,
        mensaje: "Hola! vi el depto de barrio norte"
      });
    expect(res.status).toBe(201);
    expect(res.body.creada).toBe(true);
    expect(res.body.conversation.bot_activo).toBe(true);
    expect(res.body.lead.canal).toBe("whatsapp");
    expect(res.body.lead.canal_ref).toBe("+5493815551234");
    convId = res.body.conversation.id;
    leadId = res.body.lead.id;

    // Segundo mensaje del mismo número: misma conversación, mismo lead.
    const otra = await request(app)
      .post("/v1/agent/conversations")
      .set("x-api-key", keyAgente)
      .send({ canal: "whatsapp", canal_ref: "+5493815551234" });
    expect(otra.status).toBe(200);
    expect(otra.body.creada).toBe(false);
    expect(otra.body.conversation.id).toBe(convId);
    expect(otra.body.lead.id).toBe(leadId);
  });

  it("adopta identidad Zernio en un chat legado y valida la cuenta por tenant", async () => {
    const [channelA, channelB] = await Promise.all([
      adminDb().channelAccount.create({
        data: {
          tenantId: A.tenant.id,
          canal: "whatsapp",
          zernioProfileId: "profile_agent_a",
          zernioAccountId: "account_agent_a",
          conectadaPor: A.admin.id
        }
      }),
      adminDb().channelAccount.create({
        data: {
          tenantId: B.tenant.id,
          canal: "whatsapp",
          zernioProfileId: "profile_agent_b",
          zernioAccountId: "account_agent_b",
          conectadaPor: B.admin.id
        }
      })
    ]);

    const legacy = await request(app)
      .post("/v1/agent/conversations")
      .set("x-api-key", keyAgente)
      .send({ canal: "whatsapp", canal_ref: "5493819090909", nombre: "Chat legado" });
    expect(legacy.status).toBe(201);

    const adopted = await request(app)
      .post("/v1/agent/conversations")
      .set("x-api-key", keyAgente)
      .send({
        canal: "whatsapp",
        canal_ref: "5493819090909",
        channel_account_id: channelA.id,
        provider_conversation_id: "provider_conv_9090"
      });
    expect(adopted.status).toBe(200);
    expect(adopted.body.conversation.id).toBe(legacy.body.conversation.id);
    expect(adopted.body.conversation.channel_account_id).toBe(channelA.id);
    expect(adopted.body.conversation.provider_conversation_id).toBe("provider_conv_9090");

    const crossTenant = await request(app)
      .post("/v1/agent/conversations")
      .set("x-api-key", keyAgente)
      .send({
        canal: "whatsapp",
        canal_ref: "5493818080808",
        channel_account_id: channelB.id,
        provider_conversation_id: "provider_conv_cross_tenant"
      });
    expect(crossTenant.status).toBe(404);
  });

  it("el admin supervisa el WhatsApp de Sofia pero el vendedor no lo ve antes del handoff", async () => {
    const vendedor = await loginAgent(app, A.agente.email);
    const [adminList, sellerList, sellerPending, sellerDetail, sellerTake] = await Promise.all([
      adminA.agent.get("/v1/leads?canal=whatsapp"),
      vendedor.agent.get("/v1/leads?canal=whatsapp"),
      vendedor.agent.get("/v1/leads?canal=whatsapp&sin_tomar=true&limit=1"),
      vendedor.agent.get(`/v1/leads/${leadId}`),
      vendedor.agent
        .post(`/v1/leads/${leadId}/take`)
        .set("x-csrf-token", vendedor.csrf)
    ]);

    expect(adminList.status).toBe(200);
    expect(adminList.body.data.some((l: { id: string }) => l.id === leadId)).toBe(true);
    expect(sellerList.status).toBe(200);
    expect(sellerList.body.data.some((l: { id: string }) => l.id === leadId)).toBe(false);
    expect(sellerPending.status).toBe(200);
    expect(sellerPending.body.meta.total).toBe(0);
    expect(sellerDetail.status).toBe(404);
    expect(sellerTake.status).toBe(404);

    const unchanged = await adminDb().lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(unchanged.assignedTo).toBeNull();
    expect(unchanged.tomadoAt).toBeNull();
  });

  it("registra mensajes y arma el contexto del modelo en orden cronológico", async () => {
    await request(app)
      .post(`/v1/agent/conversations/${convId}/messages`)
      .set("x-api-key", keyAgente)
      .send({ mensajes: [{ rol: "lead", contenido: "sigue disponible?" }] });
    await request(app)
      .post(`/v1/agent/conversations/${convId}/messages`)
      .set("x-api-key", keyAgente)
      .send({ mensajes: [{ rol: "agente_ia", contenido: "Hola Marcela! sí, sigue disponible" }] });

    const ctx = await request(app)
      .get(`/v1/agent/conversations/${convId}/context?k=10`)
      .set("x-api-key", keyAgente);
    expect(ctx.status).toBe(200);
    expect(ctx.body.mensajes.map((m: { rol: string }) => m.rol)).toEqual(["lead", "agente_ia"]);
    expect(ctx.body.mensajes_total).toBe(2);
    expect(ctx.body.mensajes_desde_resumen).toBe(2);
    // El id es bigint en la BD: tiene que viajar como string o rompe res.json().
    expect(typeof ctx.body.mensajes[0].id).toBe("string");
  });

  it("guarda el resumen y lo baja a las columnas del perfil", async () => {
    const res = await request(app)
      .put(`/v1/agent/conversations/${convId}/resumen`)
      .set("x-api-key", keyAgente)
      .send({
        resumen: {
          nombre: "Marcela",
          operacion: "comprar",
          presupuesto: "hasta usd 90.000",
          urgencia: "alta, se muda en marzo",
          detalles_importantes: ["el marido quiere cochera sí o sí"],
          temperatura: "caliente",
          perfil: {
            tipo_propiedad: ["departamento"],
            ciudad: "San Miguel de Tucumán",
            zonas: ["Barrio Norte"],
            presupuesto_max: 90000,
            moneda: "USD",
            dormitorios_min: 2
          }
        }
      });
    expect(res.status).toBe(200);
    const p = res.body.conversation.perfil;
    expect(p.intencion).toBe("comprar");
    expect(p.tipo_propiedad).toEqual(["departamento"]);
    expect(p.zonas).toEqual(["Barrio Norte"]);
    expect(p.presupuesto_max).toBe(90000);
    expect(p.temperatura).toBe("caliente");

    const afterSummary = await request(app)
      .get(`/v1/agent/conversations/${convId}/context?k=1`)
      .set("x-api-key", keyAgente);
    expect(afterSummary.body.mensajes_desde_resumen).toBe(0);

    await request(app)
      .post(`/v1/agent/conversations/${convId}/messages`)
      .set("x-api-key", keyAgente)
      .send({ mensajes: [{ rol: "lead", contenido: "también necesita balcón" }] });
    const afterNewMessage = await request(app)
      .get(`/v1/agent/conversations/${convId}/context?k=1`)
      .set("x-api-key", keyAgente);
    expect(afterNewMessage.body.mensajes_desde_resumen).toBe(1);
  });

  it("acepta la intención 'vender', que no matchea ninguna propiedad", async () => {
    const abrir = await request(app)
      .post("/v1/agent/conversations")
      .set("x-api-key", keyAgente)
      .send({ canal: "whatsapp", canal_ref: "+5493817778888", nombre: "Quiere vender" });
    const res = await request(app)
      .put(`/v1/agent/conversations/${abrir.body.conversation.id}/resumen`)
      .set("x-api-key", keyAgente)
      .send({ resumen: { operacion: "vender", perfil: { tipo_propiedad: ["casa"] } } });
    expect(res.status).toBe(200);
    expect(res.body.conversation.perfil.intencion).toBe("vender");
  });

  // ── Handoff ────────────────────────────────────────────────────────────────
  it("deriva: elige vendedor, calla el bot y deja el resumen como nota", async () => {
    const res = await request(app)
      .post(`/v1/agent/conversations/${convId}/handoff`)
      .set("x-api-key", keyAgente)
      .send({
        motivo: "visita",
        resumen: {
          operacion: "comprar",
          presupuesto: "hasta usd 90.000",
          detalles_importantes: ["preguntó si aceptan permuta parcial"],
          proximo_paso_sugerido: "confirmar visita sábado",
          temperatura: "caliente"
        }
      });
    expect(res.status).toBe(200);
    expect(res.body.conversation.estado).toBe("esperando_humano");
    expect(res.body.conversation.bot_activo).toBe(false);
    expect(res.body.handoff.resultado).toBe("pendiente");
    // Los vendedores se dan de alta solos en el reparto.
    expect(res.body.vendedor.id).toBe(A.agente.id);

    const lead = await adminA.agent.get(`/v1/leads/${leadId}`);
    expect(lead.body.lead.estado).toBe("en_contacto");
    expect(lead.body.lead.assignedTo).toBe(A.agente.id);

    const notas = lead.body.lead.notes as { nota: string; origen: string; userId: string | null }[];
    const delAgente = notas.find((n) => n.origen === "agente");
    expect(delAgente).toBeDefined();
    expect(delAgente!.userId).toBeNull();
    expect(delAgente!.nota).toContain("permuta parcial");
    expect(delAgente!.nota).toContain("Temperatura: caliente");
  });

  it("con el bot mudo, la conversación sigue registrando pero avisa bot_activo=false", async () => {
    const res = await request(app)
      .post("/v1/agent/conversations")
      .set("x-api-key", keyAgente)
      .send({ canal: "whatsapp", canal_ref: "+5493815551234" });
    expect(res.body.conversation.bot_activo).toBe(false);
    expect(res.body.conversation.estado).toBe("esperando_humano");
  });

  // ── Panel ──────────────────────────────────────────────────────────────────
  it("el panel lee la conversación completa y el vendedor la toma", async () => {
    const vendedor = await loginAgent(app, A.agente.email);

    const lead = await vendedor.agent.get(`/v1/leads/${leadId}`);
    expect(lead.status).toBe(200);
    expect(lead.body.lead.assignedTo).toBe(A.agente.id);

    const lista = await vendedor.agent.get(`/v1/conversations?lead_id=${leadId}`);
    expect(lista.status).toBe(200);
    expect(lista.body.data).toHaveLength(1);

    const msgs = await vendedor.agent.get(`/v1/conversations/${convId}/messages`);
    expect(msgs.body.data.length).toBeGreaterThanOrEqual(2);

    // Polling incremental: con `after` del último id no vuelve nada.
    const ultimo = msgs.body.data[msgs.body.data.length - 1].id;
    const nuevos = await vendedor.agent.get(`/v1/conversations/${convId}/messages?after=${ultimo}`);
    expect(nuevos.body.data).toHaveLength(0);

    const tomar = await vendedor.agent
      .post(`/v1/conversations/${convId}/take`)
      .set("x-csrf-token", vendedor.csrf);
    expect(tomar.status).toBe(200);
    expect(tomar.body.conversation.estado).toBe("humano");

    const takenLead = await adminDb().lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(takenLead.assignedTo).toBe(A.agente.id);
    expect(takenLead.tomadoPor).toBe(A.agente.id);
    expect(takenLead.tomadoAt).not.toBeNull();

    // Repetir la toma no cambia quién llegó primero ni su timestamp.
    const firstTakenAt = takenLead.tomadoAt!.toISOString();
    const again = await vendedor.agent
      .post(`/v1/conversations/${convId}/take`)
      .set("x-csrf-token", vendedor.csrf);
    expect(again.status).toBe(200);
    const afterAgain = await adminDb().lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(afterAgain.tomadoPor).toBe(A.agente.id);
    expect(afterAgain.tomadoAt!.toISOString()).toBe(firstTakenAt);

    // Aunque el lead ya estaba tomado, volver a tomar el chat después de
    // devolverlo al bot debe silenciarlo otra vez sin alterar la auditoría.
    const release = await vendedor.agent
      .post(`/v1/conversations/${convId}/release`)
      .set("x-csrf-token", vendedor.csrf);
    expect(release.status).toBe(200);
    expect(release.body.conversation.estado).toBe("bot");

    const retake = await vendedor.agent
      .post(`/v1/conversations/${convId}/take`)
      .set("x-csrf-token", vendedor.csrf);
    expect(retake.status).toBe(200);
    expect(retake.body.conversation.estado).toBe("humano");

    const afterRetake = await adminDb().lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(afterRetake.tomadoPor).toBe(A.agente.id);
    expect(afterRetake.tomadoAt!.toISOString()).toBe(firstTakenAt);

    // El handoff quedó cerrado como tomado: el timeout ya no aplica.
    const h = await adminDb().handoff.findFirst({ where: { conversationId: convId } });
    expect(h!.resultado).toBe("tomado");
    expect(h!.tomadoAt).not.toBeNull();
  });

  it("un vendedor no ve las conversaciones que no le tocan", async () => {
    const otro = await adminDb().user.create({
      data: {
        nombre: "Otro vendedor",
        email: "otro@agnt.test",
        passwordHash: A.agente.passwordHash,
        rol: "agente",
        tenantId: A.tenant.id
      }
    });
    expect(otro.id).toBeTruthy();

    const vendedor = await loginAgent(app, "otro@agnt.test");
    const lista = await vendedor.agent.get("/v1/conversations");
    expect(lista.body.data.every((c: { id: string }) => c.id !== convId)).toBe(true);
  });

  // ── Aislamiento ────────────────────────────────────────────────────────────
  it("la key del tenant B no ve nada del tenant A", async () => {
    const props = await request(app).get("/v1/agent/properties").set("x-api-key", keyB);
    expect(props.body.meta.total).toBe(0);

    const ctx = await request(app)
      .get(`/v1/agent/conversations/${convId}/context`)
      .set("x-api-key", keyB);
    expect(ctx.status).toBe(404);
  });

  // ── Timeout ────────────────────────────────────────────────────────────────
  it("el cron cierra sin reasignar un handoff pendiente cuyo lead ya fue tomado", async () => {
    const abrir = await request(app)
      .post("/v1/agent/conversations")
      .set("x-api-key", keyAgente)
      .send({ canal: "whatsapp", canal_ref: "+5493813334444", nombre: "Tomado antes del cron" });
    const cid = abrir.body.conversation.id as string;
    const lid = abrir.body.lead.id as string;

    const derivado = await request(app)
      .post(`/v1/agent/conversations/${cid}/handoff`)
      .set("x-api-key", keyAgente)
      .send({ motivo: "pedido_humano" });
    const responsable = derivado.body.vendedor.id as string;

    await adminDb().lead.update({
      where: { id: lid },
      data: { tomadoAt: new Date(), tomadoPor: responsable }
    });
    await adminDb().handoff.updateMany({
      where: { conversationId: cid, resultado: "pendiente" },
      data: { asignadoAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) }
    });

    const res = await request(app)
      .post("/v1/agent/handoffs/vencidos")
      .set("x-api-key", keyAgente);
    expect(res.status).toBe(200);
    expect(res.body.reasignados).toHaveLength(0);

    const handoff = await adminDb().handoff.findFirstOrThrow({
      where: { conversationId: cid }
    });
    const lead = await adminDb().lead.findUniqueOrThrow({ where: { id: lid } });
    expect(handoff.resultado).toBe("tomado");
    expect(lead.assignedTo).toBe(responsable);
    expect(lead.tomadoPor).toBe(responsable);
  });

  it("el cron no reasigna un handoff que ya fue tomado", async () => {
    const res = await request(app)
      .post("/v1/agent/handoffs/vencidos")
      .set("x-api-key", keyAgente);
    expect(res.status).toBe(200);
    expect(res.body.reasignados).toHaveLength(0);
  });

  it("reasigna al siguiente cuando venció, excluyendo al que no la tomó", async () => {
    // Conversación nueva, derivada y con el reloj puesto muy atrás.
    const abrir = await request(app)
      .post("/v1/agent/conversations")
      .set("x-api-key", keyAgente)
      .send({ canal: "whatsapp", canal_ref: "+5493811112222", nombre: "Vencido" });
    const cid = abrir.body.conversation.id as string;

    const derivado = await request(app)
      .post(`/v1/agent/conversations/${cid}/handoff`)
      .set("x-api-key", keyAgente)
      .send({ motivo: "visita" });
    const primero = derivado.body.vendedor.id as string;

    // Un mes atrás: pase lo que pase con el horario laboral, está vencido.
    await adminDb().handoff.updateMany({
      where: { conversationId: cid },
      data: { asignadoAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) }
    });

    const res = await request(app)
      .post("/v1/agent/handoffs/vencidos")
      .set("x-api-key", keyAgente);
    expect(res.body.reasignados).toHaveLength(1);
    const r = res.body.reasignados[0];
    expect(r.anterior).toBe(primero);
    expect(r.nuevo).not.toBe(primero);
  });
});

describe("Horario laboral (sin BD)", () => {
  // Defaults: lunes a viernes de 9 a 19, UTC-3.
  it("no corre el reloj fuera del horario de atención", () => {
    // Sábado 23:40 local → lunes 09:00 local: cero minutos hábiles el finde.
    const sabadoNoche = new Date("2026-07-25T02:40:00Z"); // viernes 23:40 local
    const sabadoMasTarde = new Date("2026-07-26T02:40:00Z"); // sábado 23:40 local
    expect(minutosHabilesEntre(sabadoNoche, sabadoMasTarde)).toBe(0);
  });

  it("cuenta solo la franja laboral de un día hábil", () => {
    // Miércoles 10:00 → 12:30 local = 150 minutos.
    const desde = new Date("2026-07-29T13:00:00Z");
    const hasta = new Date("2026-07-29T15:30:00Z");
    expect(minutosHabilesEntre(desde, hasta)).toBe(150);
  });

  it("un rango que cruza el cierre no cuenta la noche", () => {
    // Miércoles 18:00 → jueves 10:00 local = 60 + 60 = 120 minutos.
    const desde = new Date("2026-07-29T21:00:00Z");
    const hasta = new Date("2026-07-30T13:00:00Z");
    expect(minutosHabilesEntre(desde, hasta)).toBe(120);
  });

  it("devuelve 0 si las fechas están al revés", () => {
    const a = new Date("2026-07-29T13:00:00Z");
    const b = new Date("2026-07-29T12:00:00Z");
    expect(minutosHabilesEntre(a, b)).toBe(0);
  });
});
