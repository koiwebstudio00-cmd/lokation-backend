import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { previousPeriod } from "../src/modules/analytics/routes.js";
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
        nombre: "Prueba Agente IA",
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
    for (const path of ["overview", "leads", "sofia", "properties"]) {
      const res = await agenteA.get(`/v1/analytics/${path}?${range}`);
      expect(res.status).toBe(403);
    }
  });

  it("compara un mes calendario con el mes anterior", async () => {
    const res = await adminA.get(`/v1/analytics/overview?${range}`);
    expect(res.body.period.previous).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    // En julio no hay datos: la comparación existe pero en cero.
    expect(res.body.previous_kpis).toMatchObject({ leads_created: 0, sofia_conversations: 0 });

    const leads = await adminA.get(`/v1/analytics/leads?${range}`);
    expect(leads.body.previous_summary).toMatchObject({ total: 0, taken: 0 });
  });

  it("devuelve la actividad de Agente IA del período", async () => {
    const res = await adminA.get(`/v1/analytics/sofia?${range}`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      conversations: 1,
      handed_off: 1,
      handoff_rate: 100,
      followed_up: 0
    });
    expect(res.body.by_handoff_result).toEqual({ pendiente: 1 });
    expect(res.body.by_hour).toHaveLength(24);
    expect(res.body.by_hour[13]).toEqual({ bucket: 13, count: 1 });
    expect(res.body.by_weekday).toHaveLength(7);
    expect(res.body.previous_summary).toMatchObject({ conversations: 0 });
  });

  it("cruza demanda por zona con el inventario disponible", async () => {
    const res = await adminA.get(`/v1/analytics/properties?${range}`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      created: 1,
      leads_with_property: 1,
      properties_with_leads: 1,
      available_without_leads: 0,
      available: 1
    });
    expect(res.body.demand_by_zone).toEqual([{ zona: "Centro", consultas: 1, disponibles: 1 }]);
    expect(res.body.leads_by_operation).toEqual({ alquiler: 1 });
    expect(res.body.idle_properties).toEqual([]);
  });

  it("rechaza períodos invertidos o mayores a un año", async () => {
    const inverted = await adminA.get("/v1/analytics/leads?from=2026-09-01&to=2026-08-01");
    expect(inverted.status).toBe(400);
    expect((await adminA.get("/v1/analytics/leads?from=2026-02-30&to=2026-03-01")).status).toBe(400);
    const tooLong = await adminA.get("/v1/analytics/leads?from=2025-01-01&to=2026-08-01");
    expect(tooLong.status).toBe(400);
  });
});

describe("previousPeriod", () => {
  it("usa el mes calendario anterior para un mes completo", () => {
    expect(previousPeriod("2026-09-01", "2026-09-30", 30)).toEqual({
      from: "2026-08-01",
      to: "2026-08-31"
    });
    expect(previousPeriod("2026-01-01", "2026-01-31", 31)).toEqual({
      from: "2025-12-01",
      to: "2025-12-31"
    });
    expect(previousPeriod("2026-03-01", "2026-03-31", 31)).toEqual({
      from: "2026-02-01",
      to: "2026-02-28"
    });
  });

  it("usa la misma cantidad de días inmediatamente antes para otros rangos", () => {
    expect(previousPeriod("2026-09-01", "2026-09-30", 30).to).toBe("2026-08-31");
    expect(previousPeriod("2026-09-10", "2026-09-16", 7)).toEqual({
      from: "2026-09-03",
      to: "2026-09-09"
    });
  });
});
