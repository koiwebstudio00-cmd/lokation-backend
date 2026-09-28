import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  DB_AVAILABLE,
  adminDb,
  seedTenantWithUsers,
  TEST_PASSWORD,
  truncateAll
} from "./helpers.js";

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: ReturnType<typeof buildApp>, email: string) {
  const agent = request.agent(app);
  const res = await agent.post("/v1/auth/login").send({ email, password: TEST_PASSWORD });
  return { agent, csrf: res.body.csrf_token as string };
}

describe.runIf(DB_AVAILABLE)("CRM de leads", () => {
  const app = buildApp();
  let A: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let B: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let agenteA: { agent: Agent; csrf: string };
  let otroAgenteA: { agent: Agent; csrf: string };
  let otroAgenteAId = "";
  let adminA: { agent: Agent; csrf: string };
  let adminB: { agent: Agent; csrf: string };
  let propAId = "";
  let leadId = "";

  beforeAll(async () => {
    await truncateAll();
    A = await seedTenantWithUsers("crma");
    B = await seedTenantWithUsers("crmb");
    agenteA = await loginAgent(app, A.agente.email);
    adminA = await loginAgent(app, A.admin.email);
    adminB = await loginAgent(app, B.admin.email);
    const otroAgente = await adminDb().user.create({
      data: {
        nombre: "Otro agente A",
        email: "otro@crma.test",
        passwordHash: A.agente.passwordHash,
        rol: "agente",
        tenantId: A.tenant.id
      }
    });
    otroAgenteAId = otroAgente.id;
    otroAgenteA = await loginAgent(app, "otro@crma.test");

    // Propiedad del agente A para probar asignación automática
    const prop = await agenteA.agent
      .post("/v1/properties")
      .set("x-csrf-token", agenteA.csrf)
      .send({ titulo: "Casa consulta", operacion: "venta", tipo: "casa", precio: 100 });
    propAId = prop.body.property.id;
  });

  it("formulario público crea el lead y lo asigna al agente creador de la propiedad", async () => {
    const res = await request(app).post("/v1/public/crma/leads").send({
      property_id: propAId,
      nombre: "Juan Interesado",
      email: "juan@mail.com",
      mensaje: "Quiero visitarla"
    });
    expect(res.status).toBe(201);
    leadId = res.body.lead_id;

    const detail = await agenteA.agent.get(`/v1/leads/${leadId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.lead.canal).toBe("web");
    expect(detail.body.lead.assignedTo).toBe(A.agente.id);
    expect(detail.body.lead.property.titulo).toBe("Casa consulta");
    expect(detail.body.lead.tomadoAt).toBeNull();
    expect(detail.body.lead.tomadoPor).toBeNull();
    expect(detail.body.lead.takenBy).toBeNull();
  });

  it("una propiedad cargada por admin asigna la consulta pública al admin", async () => {
    const property = await adminDb().property.create({
      data: {
        tenantId: A.tenant.id,
        userId: A.admin.id,
        titulo: "Propiedad del admin",
        operacion: "venta",
        tipo: "casa",
        precio: 100
      }
    });
    const res = await request(app).post("/v1/public/crma/leads").send({
      property_id: property.id,
      nombre: "Interesado en propiedad del admin",
      mensaje: "Quiero conocerla"
    });
    expect(res.status).toBe(201);

    const lead = await adminDb().lead.findUniqueOrThrow({ where: { id: res.body.lead_id } });
    expect(lead.assignedTo).toBe(A.admin.id);
    await adminDb().lead.delete({ where: { id: lead.id } });
    await adminDb().property.delete({ where: { id: property.id } });
  });

  it("las consultas web generales se reparten equitativamente entre vendedores activos", async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const res = await request(app).post("/v1/public/crma/leads").send({
        nombre: `Consulta general ${i}`,
        mensaje: "Sin propiedad"
      });
      expect(res.status).toBe(201);
      ids.push(res.body.lead_id);
    }

    const leads = await adminDb().lead.findMany({ where: { id: { in: ids } } });
    const counts = new Map<string | null, number>();
    for (const lead of leads) counts.set(lead.assignedTo, (counts.get(lead.assignedTo) ?? 0) + 1);
    expect(counts.get(A.agente.id)).toBe(2);
    expect(counts.get(otroAgenteAId)).toBe(2);
    expect(counts.has(null)).toBe(false);
    await adminDb().lead.deleteMany({ where: { id: { in: ids } } });
  });

  it("el reparto excluye usuarios inactivos aunque conserven su fila histórica", async () => {
    await adminDb().user.update({ where: { id: otroAgenteAId }, data: { estado: "inactivo" } });
    const res = await request(app).post("/v1/public/crma/leads").send({
      nombre: "Con vendedor inactivo",
      mensaje: "Debe ir al vendedor activo"
    });
    const lead = await adminDb().lead.findUniqueOrThrow({ where: { id: res.body.lead_id } });
    expect(lead.assignedTo).toBe(A.agente.id);
    await adminDb().lead.delete({ where: { id: lead.id } });
    await adminDb().user.update({ where: { id: otroAgenteAId }, data: { estado: "activo" } });
  });

  it("el reparto respeta la baja temporal de vendedores_agente", async () => {
    await adminDb().vendedorAgente.update({
      where: { userId: otroAgenteAId },
      data: { activo: false }
    });
    const res = await request(app).post("/v1/public/crma/leads").send({
      nombre: "Vendedor de vacaciones",
      mensaje: "Debe ir al disponible"
    });
    const lead = await adminDb().lead.findUniqueOrThrow({ where: { id: res.body.lead_id } });
    expect(lead.assignedTo).toBe(A.agente.id);
    await adminDb().lead.delete({ where: { id: lead.id } });
    await adminDb().vendedorAgente.update({
      where: { userId: otroAgenteAId },
      data: { activo: true }
    });
  });

  it("sin vendedores activos crea el lead sin asignar para no perder la consulta", async () => {
    await adminDb().user.update({ where: { id: B.agente.id }, data: { estado: "inactivo" } });
    const res = await request(app).post("/v1/public/crmb/leads").send({
      nombre: "Sin vendedores",
      mensaje: "Debe crearse igual"
    });
    expect(res.status).toBe(201);
    const lead = await adminDb().lead.findUniqueOrThrow({ where: { id: res.body.lead_id } });
    expect(lead.assignedTo).toBeNull();
    await adminDb().lead.delete({ where: { id: lead.id } });
    await adminDb().user.update({ where: { id: B.agente.id }, data: { estado: "activo" } });
  });

  it("honeypot completo rechaza el alta", async () => {
    const res = await request(app).post("/v1/public/crma/leads").send({
      nombre: "Bot",
      mensaje: "spam",
      website: "http://spam.com"
    });
    expect(res.status).toBe(400);
  });

  it("slug inexistente devuelve 404", async () => {
    const res = await request(app)
      .post("/v1/public/no-existe/leads")
      .send({ nombre: "X", mensaje: "Y" });
    expect(res.status).toBe(404);
  });

  it("no se puede colar una propiedad de otro tenant en el formulario", async () => {
    const propB = await adminB.agent
      .post("/v1/properties")
      .set("x-csrf-token", adminB.csrf)
      .send({ titulo: "De B", operacion: "venta", tipo: "casa", precio: 1 });
    const res = await request(app).post("/v1/public/crma/leads").send({
      property_id: propB.body.property.id,
      nombre: "X",
      mensaje: "Y"
    });
    expect(res.status).toBe(404);
  });

  it("el agente ve sus leads; el admin de otro tenant no ve nada", async () => {
    const mine = await agenteA.agent.get("/v1/leads");
    expect(mine.body.meta.total).toBe(1);
    expect(mine.body.data[0].tomadoAt).toBeNull();
    expect(mine.body.data[0].tomadoPor).toBeNull();
    expect(mine.body.data[0].takenBy).toBeNull();

    const otros = await adminB.agent.get("/v1/leads");
    expect(otros.body.meta.total).toBe(0);
  });

  it("listado y detalle exponen quién tomó el lead sin filtrar datos a otro tenant", async () => {
    const tomadoAt = new Date("2026-08-24T14:30:00.000Z");
    await adminDb().lead.update({
      where: { id: leadId },
      data: { tomadoAt, tomadoPor: A.agente.id }
    });

    const mine = await agenteA.agent.get("/v1/leads");
    const row = mine.body.data.find((lead: { id: string }) => lead.id === leadId);
    expect(row.tomadoAt).toBe(tomadoAt.toISOString());
    expect(row.tomadoPor).toBe(A.agente.id);
    expect(row.takenBy).toEqual({ id: A.agente.id, nombre: A.agente.nombre });

    const detail = await agenteA.agent.get(`/v1/leads/${leadId}`);
    expect(detail.body.lead.tomadoAt).toBe(tomadoAt.toISOString());
    expect(detail.body.lead.tomadoPor).toBe(A.agente.id);
    expect(detail.body.lead.takenBy).toEqual({ id: A.agente.id, nombre: A.agente.nombre });

    const otherTenant = await adminB.agent.get(`/v1/leads/${leadId}`);
    expect(otherTenant.status).toBe(404);

    // Deja el fixture principal pendiente para las pruebas del endpoint de toma.
    await adminDb().lead.update({
      where: { id: leadId },
      data: { tomadoAt: null, tomadoPor: null }
    });
  });

  it("el vendedor asignado toma el lead de forma idempotente sin cambiar su estado", async () => {
    const first = await agenteA.agent
      .post(`/v1/leads/${leadId}/take`)
      .set("x-csrf-token", agenteA.csrf);
    expect(first.status).toBe(200);
    expect(first.body.lead.assignedTo).toBe(A.agente.id);
    expect(first.body.lead.tomadoPor).toBe(A.agente.id);
    expect(first.body.lead.tomadoAt).not.toBeNull();
    expect(first.body.lead.estado).toBe("nueva");

    const second = await agenteA.agent
      .post(`/v1/leads/${leadId}/take`)
      .set("x-csrf-token", agenteA.csrf);
    expect(second.status).toBe(200);
    expect(second.body.lead.tomadoPor).toBe(A.agente.id);
    expect(second.body.lead.tomadoAt).toBe(first.body.lead.tomadoAt);
  });

  it("un vendedor no puede tomar un lead ajeno aunque lo vea por ser dueño de la propiedad", async () => {
    const foreign = await adminDb().lead.create({
      data: {
        tenantId: A.tenant.id,
        propertyId: propAId,
        assignedTo: A.admin.id,
        canal: "web",
        nombre: "Asignado al admin",
        mensaje: "Consulta ajena"
      }
    });

    try {
      const res = await agenteA.agent
        .post(`/v1/leads/${foreign.id}/take`)
        .set("x-csrf-token", agenteA.csrf);
      expect(res.status).toBe(404);

      const unchanged = await adminDb().lead.findUniqueOrThrow({ where: { id: foreign.id } });
      expect(unchanged.tomadoAt).toBeNull();
      expect(unchanged.tomadoPor).toBeNull();
    } finally {
      await adminDb().lead.deleteMany({ where: { id: foreign.id } });
    }
  });

  it("tomar una consulta web libre la asigna al vendedor y coordina conversación y handoff", async () => {
    const free = await adminDb().lead.create({
      data: {
        tenantId: A.tenant.id,
        canal: "web",
        nombre: "Consulta libre",
        mensaje: "Necesito hablar con alguien"
      }
    });
    const conversation = await adminDb().conversation.create({
      data: {
        tenantId: A.tenant.id,
        leadId: free.id,
        canal: "web",
        canalRef: "consulta-libre-test",
        estado: "esperando_humano",
        tipoPropiedad: [],
        zonas: []
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

    // Poder ver una consulta libre no habilita a editarla por el PATCH general.
    const forbiddenEdit = await otroAgenteA.agent
      .patch(`/v1/leads/${free.id}`)
      .set("x-csrf-token", otroAgenteA.csrf)
      .send({ estado: "en_contacto" });
    expect(forbiddenEdit.status).toBe(403);

    const res = await agenteA.agent
      .post(`/v1/leads/${free.id}/take`)
      .set("x-csrf-token", agenteA.csrf);
    expect(res.status).toBe(200);
    expect(res.body.lead.assignedTo).toBe(A.agente.id);
    expect(res.body.lead.tomadoPor).toBe(A.agente.id);

    const savedConversation = await adminDb().conversation.findUniqueOrThrow({
      where: { id: conversation.id }
    });
    expect(savedConversation.estado).toBe("humano");
    expect(savedConversation.vendedorId).toBe(A.agente.id);

    const savedHandoff = await adminDb().handoff.findUniqueOrThrow({ where: { id: handoff.id } });
    expect(savedHandoff.resultado).toBe("tomado");
    expect(savedHandoff.tomadoAt).not.toBeNull();
    await adminDb().lead.delete({ where: { id: free.id } });
  });

  it("si un admin toma un lead asignado, asume su responsabilidad", async () => {
    const assigned = await adminDb().lead.create({
      data: {
        tenantId: A.tenant.id,
        assignedTo: A.agente.id,
        canal: "manual",
        nombre: "Responsable vendedor",
        mensaje: "Atiende primero el admin"
      }
    });

    const res = await adminA.agent
      .post(`/v1/leads/${assigned.id}/take`)
      .set("x-csrf-token", adminA.csrf);
    expect(res.status).toBe(200);
    expect(res.body.lead.assignedTo).toBe(A.admin.id);
    expect(res.body.lead.tomadoPor).toBe(A.admin.id);

    const previousAssignee = await agenteA.agent.get(`/v1/leads/${assigned.id}`);
    expect(previousAssignee.status).toBe(404);
    await adminDb().lead.delete({ where: { id: assigned.id } });
  });

  it("otro tenant y otro vendedor no pueden tomar una consulta asignada", async () => {
    const assigned = await adminDb().lead.create({
      data: {
        tenantId: A.tenant.id,
        assignedTo: A.agente.id,
        canal: "manual",
        nombre: "Lead protegido",
        mensaje: "No corresponde"
      }
    });

    const otherSeller = await otroAgenteA.agent
      .post(`/v1/leads/${assigned.id}/take`)
      .set("x-csrf-token", otroAgenteA.csrf);
    expect(otherSeller.status).toBe(404);

    const otherTenant = await adminB.agent
      .post(`/v1/leads/${assigned.id}/take`)
      .set("x-csrf-token", adminB.csrf);
    expect(otherTenant.status).toBe(404);

    const unchanged = await adminDb().lead.findUniqueOrThrow({ where: { id: assigned.id } });
    expect(unchanged.tomadoAt).toBeNull();
    await adminDb().lead.delete({ where: { id: assigned.id } });
  });

  it("gestión: cambio de estado y nota de seguimiento", async () => {
    const upd = await agenteA.agent
      .patch(`/v1/leads/${leadId}`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ estado: "en_contacto" });
    expect(upd.status).toBe(200);
    expect(upd.body.lead.estado).toBe("en_contacto");

    const note = await agenteA.agent
      .post(`/v1/leads/${leadId}/notes`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ nota: "Lo llamé, coordinamos visita" });
    expect(note.status).toBe(201);

    const detail = await agenteA.agent.get(`/v1/leads/${leadId}`);
    expect(detail.body.lead.notes).toHaveLength(1);
  });

  it("reasignar es solo para admins", async () => {
    const asAgente = await agenteA.agent
      .patch(`/v1/leads/${leadId}`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ assigned_to: A.admin.id });
    expect(asAgente.status).toBe(403);

    const asAdmin = await adminA.agent
      .patch(`/v1/leads/${leadId}`)
      .set("x-csrf-token", adminA.csrf)
      .send({ assigned_to: A.admin.id });
    expect(asAdmin.status).toBe(200);

    // El agente ya no lo tiene asignado, pero la propiedad es suya → sigue viéndolo
    const mine = await agenteA.agent.get("/v1/leads");
    expect(mine.body.meta.total).toBe(1);
  });

  it("alta manual queda asignada a quien la carga", async () => {
    const res = await agenteA.agent
      .post("/v1/leads")
      .set("x-csrf-token", agenteA.csrf)
      .send({ nombre: "Telefónico", mensaje: "Llamó preguntando" });
    expect(res.status).toBe(201);
    expect(res.body.lead.canal).toBe("manual");
    expect(res.body.lead.assignedTo).toBe(A.agente.id);
  });

  it("stats para el admin", async () => {
    const res = await adminA.agent.get("/v1/leads/stats");
    expect(res.status).toBe(200);
    expect(res.body.por_canal.web).toBe(1);
    expect(res.body.por_canal.manual).toBe(1);

    const asAgente = await agenteA.agent.get("/v1/leads/stats");
    expect(asAgente.status).toBe(403);
  });

  it("el conteo sin tomar respeta la visibilidad RLS de cada usuario", async () => {
    const [leadOtroVendedor, leadOtroTenant] = await Promise.all([
      adminDb().lead.create({
        data: {
          tenantId: A.tenant.id,
          assignedTo: otroAgenteAId,
          canal: "manual",
          nombre: "Pendiente de otro vendedor",
          mensaje: "No visible para agente A"
        }
      }),
      adminDb().lead.create({
        data: {
          tenantId: B.tenant.id,
          assignedTo: B.agente.id,
          canal: "manual",
          nombre: "Pendiente de otro tenant",
          mensaje: "Aislado por tenant"
        }
      })
    ]);

    try {
      const adminCount = await adminA.agent.get("/v1/leads?sin_tomar=true&limit=1");
      expect(adminCount.status).toBe(200);
      expect(adminCount.body.meta.total).toBe(2);

      const sellerCount = await agenteA.agent.get("/v1/leads?sin_tomar=true&limit=1");
      expect(sellerCount.status).toBe(200);
      expect(sellerCount.body.meta.total).toBe(1);

      const otherTenantCount = await adminB.agent.get("/v1/leads?sin_tomar=true&limit=1");
      expect(otherTenantCount.status).toBe(200);
      expect(otherTenantCount.body.meta.total).toBe(1);
    } finally {
      await adminDb().lead.deleteMany({
        where: { id: { in: [leadOtroVendedor.id, leadOtroTenant.id] } }
      });
    }
  });

  it("editar nombre y email del lead", async () => {
    const upd = await adminA.agent
      .patch(`/v1/leads/${leadId}`)
      .set("x-csrf-token", adminA.csrf)
      .send({ nombre: "Juan Editado", email: "editado@mail.com" });
    expect(upd.status).toBe(200);

    const detail = await adminA.agent.get(`/v1/leads/${leadId}`);
    expect(detail.body.lead.nombre).toBe("Juan Editado");
    expect(detail.body.lead.email).toBe("editado@mail.com");

    // email "" borra el email (queda null).
    const clear = await adminA.agent
      .patch(`/v1/leads/${leadId}`)
      .set("x-csrf-token", adminA.csrf)
      .send({ email: "" });
    expect(clear.status).toBe(200);
    const detail2 = await adminA.agent.get(`/v1/leads/${leadId}`);
    expect(detail2.body.lead.email).toBeNull();
  });

  it("el admin clasifica una consulta (potencial/fantasma), la filtra y la cuenta", async () => {
    const upd = await adminA.agent
      .patch(`/v1/leads/${leadId}`)
      .set("x-csrf-token", adminA.csrf)
      .send({ clasificacion: "potencial" });
    expect(upd.status).toBe(200);
    expect(upd.body.lead.clasificacion).toBe("potencial");

    // Filtra por clasificación: solo trae potenciales.
    const filtro = await adminA.agent.get("/v1/leads?clasificacion=potencial");
    expect(filtro.body.data.length).toBeGreaterThanOrEqual(1);
    expect(
      filtro.body.data.every((l: { clasificacion: string }) => l.clasificacion === "potencial")
    ).toBe(true);

    // Las métricas cuentan por clasificación.
    const stats = await adminA.agent.get("/v1/leads/stats");
    expect(stats.body.por_clasificacion.potencial).toBeGreaterThanOrEqual(1);

    // Se puede volver a "sin clasificar" mandando null.
    const clear = await adminA.agent
      .patch(`/v1/leads/${leadId}`)
      .set("x-csrf-token", adminA.csrf)
      .send({ clasificacion: null });
    expect(clear.status).toBe(200);
    const detail = await adminA.agent.get(`/v1/leads/${leadId}`);
    expect(detail.body.lead.clasificacion).toBeNull();
  });

  it("un vendedor no puede eliminar una consulta", async () => {
    const res = await agenteA.agent
      .delete(`/v1/leads/${leadId}`)
      .set("x-csrf-token", agenteA.csrf);
    expect(res.status).toBe(403);
  });

  it("un admin de otro tenant no puede eliminar la consulta", async () => {
    const res = await adminB.agent
      .delete(`/v1/leads/${leadId}`)
      .set("x-csrf-token", adminB.csrf);
    expect(res.status).toBe(404);
  });

  it("el admin elimina la consulta y deja de existir; el resto del tenant queda intacto", async () => {
    const antes = await adminA.agent.get("/v1/leads");
    expect(antes.body.meta.total).toBe(2); // el público + el manual

    const del = await adminA.agent
      .delete(`/v1/leads/${leadId}`)
      .set("x-csrf-token", adminA.csrf);
    expect(del.status).toBe(204);

    const gone = await adminA.agent.get(`/v1/leads/${leadId}`);
    expect(gone.status).toBe(404);

    const despues = await adminA.agent.get("/v1/leads");
    expect(despues.body.meta.total).toBe(1); // sobrevive el manual
  });
});
