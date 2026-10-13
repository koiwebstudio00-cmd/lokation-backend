import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Cierre y trazabilidad de consultas", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let leadId: string;
  let adminA: ReturnType<typeof request.agent>;
  let adminB: ReturnType<typeof request.agent>;
  let agenteB: ReturnType<typeof request.agent>;
  let csrfA: string;
  let csrfB: string;

  beforeAll(async () => {
    await truncateAll();
    a = await seedTenantWithUsers("closure-a");
    b = await seedTenantWithUsers("closure-b");
    const lead = await adminDb().lead.create({ data: {
      tenantId: a.tenant.id,
      assignedTo: a.agente.id,
      canal: "manual",
      nombre: "Consulta de prueba",
      mensaje: "Busco un departamento"
    } });
    leadId = lead.id;
    adminA = request.agent(app);
    adminB = request.agent(app);
    agenteB = request.agent(app);
    csrfA = (await adminA.post("/v1/auth/login").send({ email: a.admin.email, password: TEST_PASSWORD })).body.csrf_token;
    csrfB = (await adminB.post("/v1/auth/login").send({ email: b.admin.email, password: TEST_PASSWORD })).body.csrf_token;
    await agenteB.post("/v1/auth/login").send({ email: b.agente.email, password: TEST_PASSWORD });
  });

  it("exige detalles al cerrar y registra el motivo con actor y fecha", async () => {
    const shortcut = await adminA.patch(`/v1/leads/${leadId}`).set("x-csrf-token", csrfA).send({ estado: "perdida" });
    expect(shortcut.status).toBe(400);
    const missingReason = await adminA.post(`/v1/leads/${leadId}/close`).set("x-csrf-token", csrfA).send({ resultado: "perdida" });
    expect(missingReason.status).toBe(400);
    const closed = await adminA.post(`/v1/leads/${leadId}/close`).set("x-csrf-token", csrfA)
      .send({ resultado: "perdida", motivo: "no_califica", nota: "Falta documentación" });
    expect(closed.status).toBe(200);
    expect(closed.body.lead.estado).toBe("perdida");
    const detail = await adminA.get(`/v1/leads/${leadId}`);
    expect(detail.body.lead.statusHistory).toEqual([
      expect.objectContaining({
        fromState: "nueva", toState: "perdida", reason: "no_califica",
        note: "Falta documentación", actorId: a.admin.id
      })
    ]);
  });

  it("conserva historial al reabrir y corregir el resultado", async () => {
    const reopened = await adminA.patch(`/v1/leads/${leadId}`).set("x-csrf-token", csrfA).send({ estado: "en_contacto" });
    expect(reopened.status).toBe(200);
    const won = await adminA.post(`/v1/leads/${leadId}/close`).set("x-csrf-token", csrfA)
      .send({ resultado: "ganada", operacion: "alquiler" });
    expect(won.status).toBe(200);
    const detail = await adminA.get(`/v1/leads/${leadId}`);
    expect(detail.body.lead.statusHistory).toHaveLength(3);
    expect(detail.body.lead.statusHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromState: "en_contacto", toState: "ganada", operation: "alquiler" })
    ]));
  });

  it("no expone ni permite cerrar consultas de otra inmobiliaria", async () => {
    expect((await adminB.get(`/v1/leads/${leadId}`)).status).toBe(404);
    const denied = await adminB.post(`/v1/leads/${leadId}/close`).set("x-csrf-token", csrfB)
      .send({ resultado: "perdida", motivo: "otro" });
    expect(denied.status).toBe(404);
    expect((await agenteB.get(`/v1/leads/${leadId}`)).status).toBe(404);
    const rows = await runWithContext({ tenantId: b.tenant.id, userId: b.admin.id, rol: "admin" },
      (tx) => tx.leadStatusHistory.findMany());
    expect(rows).toHaveLength(0);
  });
});
