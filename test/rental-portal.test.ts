import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Portal de alquileres por inmobiliaria", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let contractA: string;
  let contractB: string;
  let ownerA: string;
  let renterA: string;
  let ownerB: string;
  let adminA: ReturnType<typeof request.agent>;
  let adminB: ReturnType<typeof request.agent>;
  let csrfA: string;
  let csrfB: string;
  let ownerTokenA: string;
  let ownerTokenB: string;
  let renterTokenA: string;

  beforeAll(async () => {
    await truncateAll();
    a = await seedTenantWithUsers("portal-a");
    b = await seedTenantWithUsers("portal-b");
    const db = adminDb();
    const makeContract = async (seed: typeof a, slug: string) => {
      const property = await db.property.create({ data: { tenantId: seed.tenant.id,
        userId: seed.agente.id, titulo: `Depto ${slug}`, slug,
        operacion: "alquiler", tipo: "departamento", precio: 400000, moneda: "ARS" } });
      const owner = await db.rentalPerson.create({ data: { tenantId: seed.tenant.id,
        createdById: seed.admin.id, nombre: `Dueño ${slug}`, email: "compartido@portal.test", roles: ["propietario"] } });
      const renter = await db.rentalPerson.create({ data: { tenantId: seed.tenant.id,
        createdById: seed.admin.id, nombre: `Inquilino ${slug}`,
        email: `inquilino@${slug}.test`, roles: ["inquilino"] } });
      const contract = await db.rentalContract.create({ data: { tenantId: seed.tenant.id,
        propertyId: property.id, ownerPersonId: owner.id, tenantPersonId: renter.id,
        createdById: seed.admin.id, startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"),
        monthlyRent: "400000", currency: "ARS", dueDay: 10, status: "vigente" } });
      return { property, owner, renter, contract };
    };
    const first = await makeContract(a, "portal-a");
    const second = await makeContract(b, "portal-b");
    contractA = first.contract.id; contractB = second.contract.id;
    ownerA = first.owner.id; ownerB = second.owner.id; renterA = first.renter.id;
    const charge = await db.rentalCharge.create({ data: { tenantId: a.tenant.id, contractId: contractA,
      createdById: a.admin.id, period: new Date("2026-09-01"), dueDate: new Date("2026-09-10"),
      amount: "400000", currency: "ARS" } });
    await db.rentalPayment.create({ data: { tenantId: a.tenant.id, chargeId: charge.id,
      createdById: a.admin.id, idempotencyKey: "00000000-0000-4000-8000-0000000000aa",
      amount: "400000", paidAt: new Date("2026-09-10"), method: "transferencia", reference: "PRIVADA" } });
    await db.rentalSettlement.create({ data: { tenantId: a.tenant.id, contractId: contractA,
      chargeId: charge.id, createdById: a.admin.id, gross: "400000", commission: "10000",
      expenses: "0", net: "390000", currency: "ARS" } });
    await db.rentalServiceAccount.create({ data: { tenantId: a.tenant.id,
      propertyId: first.property.id, createdById: a.admin.id, type: "luz",
      provider: "Proveedor", visibility: "inquilino", accountNumber: "LUZ-PRIVADA" } });
    adminA = request.agent(app); adminB = request.agent(app);
    csrfA = (await adminA.post("/v1/auth/login").send({ email: a.admin.email, password: TEST_PASSWORD })).body.csrf_token;
    csrfB = (await adminB.post("/v1/auth/login").send({ email: b.admin.email, password: TEST_PASSWORD })).body.csrf_token;
  });

  async function invite(admin: ReturnType<typeof request.agent>, csrf: string, personId: string) {
    const invited = await admin.post(`/v1/rental-people/${personId}/portal-invite`).set("x-csrf-token", csrf).send({});
    expect(invited.status).toBe(201);
    const token = new URL(invited.body.dev_accept_url, "http://localhost").searchParams.get("token");
    const slug = new URL(invited.body.dev_accept_url, "http://localhost").pathname.split("/")[2];
    const accepted = await request(app).post("/v1/portal/invitations/accept").send({ token, slug, password: TEST_PASSWORD });
    expect(accepted.status, JSON.stringify({ slug, body: accepted.body })).toBe(201);
  }

  it("invita y autentica una identidad compartida en dos inmobiliarias, con sesiones separadas", async () => {
    await invite(adminA, csrfA, ownerA);
    await invite(adminB, csrfB, ownerB);
    await invite(adminA, csrfA, renterA);
    const login = async (slug: string, email: string) => {
      const response = await request(app).post(`/v1/portal/${slug}/login`).send({ email, password: TEST_PASSWORD });
      expect(response.status).toBe(200);
      return response.body.token as string;
    };
    ownerTokenA = await login("portal-a", "compartido@portal.test");
    ownerTokenB = await login("portal-b", "compartido@portal.test");
    renterTokenA = await login("portal-a", "inquilino@portal-a.test");
    expect((await request(app).get("/v1/portal/portal-a/contracts").set("Authorization", `Bearer ${ownerTokenA}`))
      .body.data).toHaveLength(1);
    expect((await request(app).get("/v1/portal/portal-b/contracts").set("Authorization", `Bearer ${ownerTokenA}`)).status).toBe(401);
    expect((await request(app).get("/v1/portal/portal-b/contracts").set("Authorization", `Bearer ${ownerTokenB}`))
      .body.data[0].id).toBe(contractB);
  });

  it("muestra pagos sólo al inquilino, liquidaciones sólo al propietario y aísla contratos", async () => {
    const owner = await request(app).get(`/v1/portal/portal-a/contracts/${contractA}`)
      .set("Authorization", `Bearer ${ownerTokenA}`);
    const renter = await request(app).get(`/v1/portal/portal-a/contracts/${contractA}`)
      .set("Authorization", `Bearer ${renterTokenA}`);
    expect(owner.status).toBe(200);
    expect(owner.body.role).toBe("propietario");
    expect(owner.body.settlements).toHaveLength(1);
    expect(owner.body.charges[0].payments).toHaveLength(0);
    expect(owner.body.services).toHaveLength(0);
    expect(renter.status).toBe(200);
    expect(renter.body.role).toBe("inquilino");
    expect(renter.body.settlements).toHaveLength(0);
    expect(renter.body.charges[0].payments[0].reference).toBe("PRIVADA");
    expect(renter.body.services[0].accountNumber).toBe("LUZ-PRIVADA");
    expect((await request(app).get(`/v1/portal/portal-a/contracts/${contractB}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)).status).toBe(404);
  });

  it("recibe una consulta del inquilino y permite responderla sólo al administrador del tenant", async () => {
    const created = await request(app).post(`/v1/portal/portal-a/contracts/${contractA}/inquiries`)
      .set("Authorization", `Bearer ${renterTokenA}`).send({ category: "reclamo",
        title: "Problema con el pago", description: "No veo el pago de septiembre en mi contrato." });
    expect(created.status).toBe(201);
    const listed = await adminA.get("/v1/rental-inquiries");
    expect(listed.body.data.some((item: { id: string }) => item.id === created.body.item.id)).toBe(true);
    expect((await adminB.get("/v1/rental-inquiries")).body.data).toHaveLength(0);
    const answered = await adminA.post(`/v1/rental-inquiries/${created.body.item.id}/respond`)
      .set("x-csrf-token", csrfA).send({ status: "resuelta", response: "El pago ya figura informado." });
    expect(answered.status).toBe(200);
    const detail = await request(app).get(`/v1/portal/portal-a/contracts/${contractA}`)
      .set("Authorization", `Bearer ${renterTokenA}`);
    expect(detail.body.inquiries[0].response).toBe("El pago ya figura informado.");
    expect((await request(app).get(`/v1/portal/portal-a/contracts/${contractA}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)).body.inquiries).toHaveLength(0);
  });

  it("guarda un PDF privado y respeta la visibilidad por contrato y rol", async () => {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    const upload = await adminA.post(`/v1/rental-contracts/${contractA}/documents`)
      .query({ title: "Comprobante de prueba", kind: "comprobante", visibility: "inquilino" })
      .set("x-csrf-token", csrfA).set("Content-Type", "application/pdf").send(pdf);
    expect(upload.status).toBe(201);
    const documentId = upload.body.document.id;
    expect((await request(app).get(`/v1/portal/portal-a/documents/${documentId}/content`)
      .set("Authorization", `Bearer ${renterTokenA}`)).status).toBe(200);
    expect((await request(app).get(`/v1/portal/portal-a/documents/${documentId}/content`)
      .set("Authorization", `Bearer ${ownerTokenA}`)).status).toBe(404);
    expect((await adminB.get(`/v1/rental-documents/${documentId}/content`)).status).toBe(404);
    expect((await adminA.delete(`/v1/rental-documents/${documentId}`).set("x-csrf-token", csrfA)).status).toBe(200);
  });

  it("revoca el acceso sin afectar al otro tenant", async () => {
    expect((await adminA.delete(`/v1/rental-people/${ownerA}/portal-access`)
      .set("x-csrf-token", csrfA)).status).toBe(200);
    expect((await request(app).get("/v1/portal/portal-a/contracts")
      .set("Authorization", `Bearer ${ownerTokenA}`)).status).toBe(401);
    expect((await request(app).get("/v1/portal/portal-b/contracts")
      .set("Authorization", `Bearer ${ownerTokenB}`)).status).toBe(200);
  });

  it("restablece contraseña por enlace de un solo uso y revoca sesiones anteriores", async () => {
    const forgotten = await request(app).post("/v1/portal/portal-b/forgot-password")
      .send({ email: "compartido@portal.test" });
    expect(forgotten.status).toBe(200);
    const token = new URL(forgotten.body.dev_reset_url, "http://localhost").searchParams.get("token");
    const changed = await request(app).post("/v1/portal/portal-b/reset-password")
      .send({ token, password: "contraseña-nueva-123" });
    expect(changed.status).toBe(200);
    expect((await request(app).post("/v1/portal/portal-b/reset-password")
      .send({ token, password: "otra-contraseña-123" })).status).toBe(401);
    expect((await request(app).get("/v1/portal/portal-b/contracts")
      .set("Authorization", `Bearer ${ownerTokenB}`)).status).toBe(401);
    expect((await request(app).post("/v1/portal/portal-b/login")
      .send({ email: "compartido@portal.test", password: TEST_PASSWORD })).status).toBe(401);
    expect((await request(app).post("/v1/portal/portal-b/login")
      .send({ email: "compartido@portal.test", password: "contraseña-nueva-123" })).status).toBe(200);
  });
});
