import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Clientes unificados", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: typeof a;
  let adminA: ReturnType<typeof request.agent>;
  let adminB: ReturnType<typeof request.agent>;
  let agentA: ReturnType<typeof request.agent>;
  let csrf: string;
  let csrfB: string;
  let personId: string;
  let leadId: string;
  let foreignLead: string;
  let contractId: string;
  beforeAll(async () => {
    await truncateAll();
    a = await seedTenantWithUsers("client-a"); b = await seedTenantWithUsers("client-b");
    adminA = request.agent(app); adminB = request.agent(app); agentA = request.agent(app);
    csrf = (await adminA.post("/v1/auth/login").send({ email: a.admin.email, password: TEST_PASSWORD })).body.csrf_token;
    csrfB = (await adminB.post("/v1/auth/login").send({ email: b.admin.email, password: TEST_PASSWORD })).body.csrf_token;
    await agentA.post("/v1/auth/login").send({ email: a.agente.email, password: TEST_PASSWORD });
    const db = adminDb();
    personId = (await db.rentalPerson.create({ data: { tenantId: a.tenant.id, createdById: a.admin.id, nombre: "Cliente previo", roles: ["propietario"] } })).id;
    const renter = await db.rentalPerson.create({ data: { tenantId: a.tenant.id, createdById: a.admin.id, nombre: "Inquilino previo", roles: ["inquilino"] } });
    const property = await db.property.create({ data: { tenantId: a.tenant.id, userId: a.admin.id, slug: "client-property", titulo: "Propiedad cliente", operacion: "alquiler", tipo: "departamento", precio: 1000, moneda: "ARS" } });
    contractId = (await db.rentalContract.create({ data: { tenantId: a.tenant.id, createdById: a.admin.id, propertyId: property.id, ownerPersonId: personId, tenantPersonId: renter.id, startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), monthlyRent: 1000, currency: "ARS", dueDay: 10 } })).id;
    leadId = (await db.lead.create({ data: { tenantId: a.tenant.id, nombre: "Operación local", mensaje: "Venta de prueba", canal: "manual", propertyId: property.id } })).id;
    foreignLead = (await db.lead.create({ data: { tenantId: b.tenant.id, nombre: "Operación ajena", mensaje: "Privada", canal: "manual" } })).id;
  });
  it("amplía roles sin cambiar identidad ni perder contratos", async () => {
    const updated = await adminA.patch(`/v1/clients/${personId}`).set("x-csrf-token", csrf).send({ roles: ["propietario", "comprador", "vendedor"] });
    expect(updated.status).toBe(200);
    const detail = await adminA.get(`/v1/clients/${personId}`);
    expect(detail.body.person.id).toBe(personId);
    expect(detail.body.person.ownedContracts.map((c: { id: string }) => c.id)).toContain(contractId);
    expect((await adminA.get(`/v1/rental-people/${personId}`)).body.person.id).toBe(personId);
    const list = await adminA.get("/v1/clients?role=comprador&q=previo");
    expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([personId]);
    expect((await adminA.get("/v1/clients?role=otro-invalido")).status).toBe(400);
    const created = await adminA.post("/v1/clients").set("x-csrf-token", csrf).send({ nombre: "Comprador nuevo", roles: ["comprador"] });
    expect(created.status).toBe(201);
  });
  it("vincula de forma idempotente, permite volver desde operación y conserva el original al desvincular", async () => {
    for (let i = 0; i < 2; i++) expect((await adminA.post(`/v1/clients/${personId}/operations`).set("x-csrf-token", csrf).send({ lead_id: leadId })).status).toBe(201);
    expect((await adminA.get(`/v1/clients/${personId}`)).body.person.commercialLinks).toHaveLength(1);
    expect((await adminA.get(`/v1/clients/operations/${leadId}/people`)).body.data[0].person.id).toBe(personId);
    expect((await adminA.get(`/v1/clients/${personId}/operation-candidates`)).body.meta.total).toBe(0);
    expect((await adminA.delete(`/v1/clients/${personId}/operations/${leadId}`).set("x-csrf-token", csrf)).status).toBe(200);
    expect(await adminDb().lead.findUnique({ where: { id: leadId } })).not.toBeNull();
    expect((await adminA.get(`/v1/clients/${personId}`)).body.person.commercialLinks).toHaveLength(0);
    expect((await adminA.get(`/v1/clients/${personId}/operation-candidates?q=local`)).body.data[0].id).toBe(leadId);
  });
  it("rechaza vínculos cruzados en API, RLS y claves compuestas", async () => {
    expect((await adminA.post(`/v1/clients/${personId}/operations`).set("x-csrf-token", csrf).send({ lead_id: foreignLead })).status).toBe(404);
    expect((await adminB.get(`/v1/clients/${personId}`)).status).toBe(404);
    expect((await adminB.get(`/v1/clients/${personId}/operation-candidates`)).status).toBe(404);
    expect((await adminB.get(`/v1/clients/operations/${leadId}/people`)).status).toBe(404);
    expect((await adminB.delete(`/v1/clients/${personId}/operations/${leadId}`).set("x-csrf-token", csrfB)).status).toBe(404);
    await expect(adminDb().clientOperation.create({ data: { personId, leadId: foreignLead, tenantId: a.tenant.id } })).rejects.toThrow();
    await adminA.post(`/v1/clients/${personId}/operations`).set("x-csrf-token", csrf).send({ lead_id: leadId });
    expect(await runWithContext({ tenantId: b.tenant.id, userId: b.admin.id, rol: "admin" }, (tx) => tx.clientOperation.findMany())).toHaveLength(0);
    await expect(runWithContext({ tenantId: b.tenant.id, userId: b.admin.id, rol: "admin" }, (tx) => tx.clientOperation.create({ data: { personId, leadId, tenantId: a.tenant.id } }))).rejects.toThrow();
  });
  it("mantiene el directorio restringido a administradores y no da permisos de portal por un rol comercial", async () => {
    expect((await request(app).get("/v1/clients")).status).toBe(401);
    expect((await agentA.get("/v1/clients")).status).toBe(403);
    expect((await agentA.get(`/v1/clients/${personId}/operation-candidates`)).status).toBe(403);
    expect((await adminA.get(`/v1/rental-people/${personId}/portal-access`)).body.access).toBeNull();
  });
});
