import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  adminDb,
  DB_AVAILABLE,
  seedTenantWithUsers,
  TEST_PASSWORD,
  truncateAll
} from "./helpers.js";

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: ReturnType<typeof buildApp>, email: string) {
  const agent = request.agent(app);
  await agent.post("/v1/auth/login").send({ email, password: TEST_PASSWORD });
  return agent;
}

describe.runIf(DB_AVAILABLE)("Analíticas", () => {
  const app = buildApp();
  let adminA: Agent;
  let agenteA: Agent;
  let sellerId = "";

  beforeAll(async () => {
    await truncateAll();
    const A = await seedTenantWithUsers("analytics-a");
    const B = await seedTenantWithUsers("analytics-b");
    sellerId = A.agente.id;
    adminA = await loginAgent(app, A.admin.email);
    agenteA = await loginAgent(app, A.agente.email);

    const property = await adminDb().property.create({
      data: {
        tenantId: A.tenant.id,
        userId: A.agente.id,
        titulo: "Departamento Centro",
        operacion: "alquiler",
        tipo: "departamento",
        precio: 100,
        zona: "Centro",
        createdAt: new Date("2026-08-01T12:00:00Z")
      }
    });

    const won = await adminDb().lead.create({
      data: {
        tenantId: A.tenant.id,
        assignedTo: A.agente.id,
        canal: "web",
        nombre: "Lead web",
        mensaje: "Consulta general",
        estado: "ganada",
        clasificacion: "potencial",
        tomadoAt: new Date("2026-08-10T12:30:00Z"),
        tomadoPor: A.agente.id,
        tomadoOrigen: "panel",
        createdAt: new Date("2026-08-10T12:00:00Z")
      }
    });

    const whatsapp = await adminDb().lead.create({
      data: {
        tenantId: A.tenant.id,
        assignedTo: A.agente.id,
        canal: "whatsapp",
        canalRef: "5493810000000",
        nombre: "Lead WhatsApp",
        mensaje: "Busco una casa",
        createdAt: new Date("2026-08-11T13:00:00Z")
      }
    });

    await adminDb().lead.create({
      data: {
        tenantId: A.tenant.id,
        propertyId: property.id,
        assignedTo: A.admin.id,
        canal: "manual",
        nombre: "Lead manual",
        mensaje: "Consulta cargada",
        estado: "en_contacto",
        tomadoAt: new Date("2026-08-12T16:00:00Z"),
        tomadoPor: A.admin.id,
        tomadoOrigen: "panel",
        createdAt: new Date("2026-08-12T14:00:00Z")
      }
    });

    // El probador del agente usa web + canal_ref y no es una consulta comercial.
    await adminDb().lead.create({
      data: {
        tenantId: A.tenant.id,
        canal: "web",
        canalRef: "prueba-analytics",
        nombre: "Prueba Sofía",
        mensaje: "No debe contar",
        createdAt: new Date("2026-08-13T14:00:00Z")
      }
    });

    await adminDb().lead.create({
      data: {
        tenantId: B.tenant.id,
        assignedTo: B.agente.id,
        canal: "web",
        nombre: "Lead otro tenant",
        mensaje: "No debe filtrarse desde la aplicación",
        createdAt: new Date("2026-08-10T12:00:00Z")
      }
    });

    const conversation = await adminDb().conversation.create({
      data: {
        tenantId: A.tenant.id,
        leadId: whatsapp.id,
        canal: "whatsapp",
        canalRef: "5493810000000",
        estado: "esperando_humano",
        vendedorId: A.agente.id,
        createdAt: new Date("2026-08-11T13:00:00Z")
      }
    });
    await adminDb().handoff.create({
      data: {
        tenantId: A.tenant.id,
        conversationId: conversation.id,
        vendedorId: A.agente.id,
        motivo: "Pedido explícito",
        asignadoAt: new Date("2026-08-11T13:10:00Z")
      }
    });

    expect(won.id).toBeTruthy();
  });

  const range = "from=2026-08-01&to=2026-08-31&timezone=UTC";

  it("calcula el resumen sobre la cohorte del tenant sin incluir pruebas web", async () => {
    const res = await adminA.get(`/v1/analytics/overview?${range}`);
    expect(res.status).toBe(200);
    expect(res.body.period.cohort_definition).toContain("estado actual");
    expect(res.body.kpis).toMatchObject({
      leads_created: 3,
      leads_taken: 2,
      take_rate: 66.7,
      median_take_minutes: 75,
      nuevas: 1,
      en_contacto: 1,
      ganadas: 1,
      cohort_conversion_rate: 33.3,
      sofia_conversations: 1,
      handed_off_conversations: 1,
      handoff_rate: 100,
      active_properties: 1,
      active_properties_without_leads: 0
    });
  });

  it("devuelve distribuciones y tiempos de consultas", async () => {
    const res = await adminA.get(`/v1/analytics/leads?${range}`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      total: 3,
      taken: 2,
      untaken: 1,
      assigned: 3,
      unassigned: 0,
      median_take_minutes: 75,
      p90_take_minutes: 111
    });
    expect(res.body.by_channel).toEqual({ web: 1, whatsapp: 1, manual: 1 });
    expect(res.body.by_classification).toEqual({ potencial: 1, sin_clasificar: 2 });
    expect(res.body.by_property_relation).toEqual({ general: 2, con_propiedad: 1 });
    expect(res.body.daily).toHaveLength(3);
    expect(res.body.top_properties).toEqual([
      expect.objectContaining({ titulo: "Departamento Centro", destacada: false, consultas: 1 })
    ]);
  });

  it("aplica filtros de vendedor y canal en backend", async () => {
    const res = await adminA.get(
      `/v1/analytics/leads?${range}&seller_id=${sellerId}&canal=whatsapp`
    );
    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(1);
    expect(res.body.by_channel).toEqual({ whatsapp: 1 });
  });

  it("no permite que un vendedor consulte analíticas globales", async () => {
    const res = await agenteA.get(`/v1/analytics/overview?${range}`);
    expect(res.status).toBe(403);
  });

  it("rechaza períodos invertidos o mayores a un año", async () => {
    const inverted = await adminA.get("/v1/analytics/leads?from=2026-09-01&to=2026-08-01");
    expect(inverted.status).toBe(400);
    const tooLong = await adminA.get("/v1/analytics/leads?from=2025-01-01&to=2026-08-01");
    expect(tooLong.status).toBe(400);
  });
});
