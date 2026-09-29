import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { processDeliveriesOnce } from "../src/modules/webhooks/worker.js";
import { setTenantEstado } from "../src/modules/tenants/service.js";
import {
  adminDb,
  DB_AVAILABLE,
  seedSuperAdmin,
  seedTenantWithUsers,
  TEST_PASSWORD,
  truncateAll
} from "./helpers.js";

type Agent = ReturnType<typeof request.agent>;

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe.runIf(DB_AVAILABLE)("Webhooks: outbox, entrega firmada y reintentos", () => {
  const app = buildApp();
  let adminA: { agent: Agent; csrf: string };
  let receiver: Server;
  let receiverUrl = "";
  let respondWith = 200;
  const received: Received[] = [];
  let endpointId = "";
  let secret = "";
  let tenantId = "";
  let superAdminId = "";
  let adminEmail = "";

  beforeAll(async () => {
    await truncateAll();
    const A = await seedTenantWithUsers("hooks");
    adminEmail = A.admin.email;
    tenantId = A.tenant.id;
    superAdminId = (await seedSuperAdmin()).id;
    const agent = request.agent(app);
    const login = await agent
      .post("/v1/auth/login")
      .send({ email: A.admin.email, password: TEST_PASSWORD });
    adminA = { agent, csrf: login.body.csrf_token };

    // Receptor HTTP local
    receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.statusCode = respondWith;
        res.end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const address = receiver.address();
    receiverUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/hook`;
  });

  afterAll(async () => {
    await new Promise((resolve) => receiver.close(resolve));
  });

  it("el admin crea un endpoint y recibe el secret una sola vez", async () => {
    const res = await adminA.agent
      .post("/v1/webhooks")
      .set("x-csrf-token", adminA.csrf)
      .send({ url: receiverUrl, eventos: ["lead.created", "property.created"] });
    expect(res.status).toBe(201);
    expect(res.body.endpoint.secret).toBeTruthy();
    endpointId = res.body.endpoint.id;
    secret = res.body.endpoint.secret;

    const list = await adminA.agent.get("/v1/webhooks");
    expect(list.body.data[0].secret).toBeUndefined(); // nunca más visible
  });

  it("un evento de negocio genera la delivery (outbox) y el worker la entrega firmada", async () => {
    // Evento real: alta de propiedad (suscripto)
    await adminA.agent
      .post("/v1/properties")
      .set("x-csrf-token", adminA.csrf)
      .send({ titulo: "Con webhook", operacion: "venta", tipo: "casa", precio: 9 });

    const processed = await processDeliveriesOnce();
    expect(processed).toBeGreaterThanOrEqual(1);
    expect(received).toHaveLength(1);

    const r = received[0]!;
    expect(r.headers["x-ubikka-event"]).toBe("property.created");
    expect(r.headers["user-agent"]).toBe("Ubikka-Webhooks/1.0");
    const envelope = JSON.parse(r.body);
    expect(envelope.data.titulo).toBe("Con webhook");
    expect(envelope.data.notas).toBeUndefined(); // sin campos internos

    // Firma HMAC verificable con el secret
    const expected = `sha256=${createHmac("sha256", secret).update(r.body).digest("hex")}`;
    expect(r.headers["x-ubikka-signature"]).toBe(expected);

    const deliveries = await adminA.agent.get(`/v1/webhooks/${endpointId}/deliveries`);
    expect(deliveries.body.data[0].estado).toBe("entregada");
  });

  it("dos workers concurrentes envían la misma entrega una sola vez", async () => {
    const created = await request(app).post("/v1/public/hooks/leads").send({
      nombre: "Claim concurrente",
      mensaje: "prueba"
    });
    expect(created.status).toBe(201);
    let respond: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const first = processDeliveriesOnce();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(await processDeliveriesOnce()).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      respond!(new Response(null, { status: 200 }));
      expect(await first).toBe(1);
    } finally {
      respond?.(new Response(null, { status: 200 }));
      vi.unstubAllGlobals();
    }
    const delivery = await adminDb().webhookDelivery.findFirstOrThrow({
      where: { endpointId, evento: "lead.created" }, orderBy: { createdAt: "desc" }
    });
    expect(delivery.estado).toBe("entregada");
  });

  it("un claim vigente bloquea duplicados y uno vencido se recupera", async () => {
    const created = await request(app).post("/v1/public/hooks/leads").send({
      nombre: "Lease de entrega",
      mensaje: "prueba"
    });
    expect(created.status).toBe(201);
    const delivery = await adminDb().webhookDelivery.findFirstOrThrow({
      where: { endpointId, estado: "pendiente" }, orderBy: { createdAt: "desc" }
    });
    const before = received.length;
    await adminDb().webhookDelivery.update({
      where: { id: delivery.id },
      data: { claimId: randomUUID(), claimedAt: new Date() }
    });
    expect(await processDeliveriesOnce()).toBe(0);
    expect(received).toHaveLength(before);

    await adminDb().webhookDelivery.update({
      where: { id: delivery.id },
      data: { claimedAt: new Date(Date.now() - 120_000) }
    });
    expect(await processDeliveriesOnce()).toBe(1);
    expect(received).toHaveLength(before + 1);
    const stored = await adminDb().webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(stored.estado).toBe("entregada");
    expect(stored.claimId).toBeNull();
  });

  it("una suspensión no deja que un envío HTTP en curso reactive la entrega", async () => {
    const created = await request(app).post("/v1/public/hooks/leads").send({
      nombre: "En tránsito",
      mensaje: "prueba"
    });
    expect(created.status).toBe(201);
    const delivery = await adminDb().webhookDelivery.findFirstOrThrow({
      where: { endpointId, estado: "pendiente" }, orderBy: { createdAt: "desc" }
    });
    let respond: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const operator = { userId: superAdminId, rol: "super_admin" as const };
    try {
      const processing = processDeliveriesOnce();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await setTenantEstado(operator, tenantId, "suspendido");
      respond!(new Response(null, { status: 200 }));
      await processing;
      const stored = await adminDb().webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(stored.estado).toBe("fallida");
      expect(stored.claimId).toBeNull();
    } finally {
      respond?.(new Response(null, { status: 200 }));
      vi.unstubAllGlobals();
      await setTenantEstado(operator, tenantId, "activo");
      const login = await adminA.agent.post("/v1/auth/login")
        .send({ email: adminEmail, password: TEST_PASSWORD });
      expect(login.status).toBe(200);
      adminA.csrf = login.body.csrf_token;
    }
  });

  it("si el receptor falla, la delivery queda pendiente con reintento programado", async () => {
    respondWith = 500;
    await request(app).post("/v1/public/hooks/leads").send({
      nombre: "Con retry",
      mensaje: "prueba"
    });

    await processDeliveriesOnce();
    const deliveries = await adminA.agent.get(`/v1/webhooks/${endpointId}/deliveries`);
    const lead = deliveries.body.data.find(
      (d: { evento: string }) => d.evento === "lead.created"
    );
    expect(lead.estado).toBe("pendiente");
    expect(lead.intentos).toBe(1);
    expect(lead.nextRetryAt).toBeTruthy();

    // El retry no está vencido todavía → no se reprocesa
    await processDeliveriesOnce();
    const again = await adminA.agent.get(`/v1/webhooks/${endpointId}/deliveries`);
    const leadAgain = again.body.data.find(
      (d: { evento: string }) => d.evento === "lead.created"
    );
    expect(leadAgain.intentos).toBe(1);
    respondWith = 200;
  });

  it("test/ping encola una delivery para el endpoint", async () => {
    const res = await adminA.agent
      .post(`/v1/webhooks/${endpointId}/test`)
      .set("x-csrf-token", adminA.csrf)
      .send({});
    expect(res.status).toBe(200);
    await processDeliveriesOnce();
    const pings = received.filter((r) => r.headers["x-ubikka-event"] === "ping");
    expect(pings.length).toBe(1);
  });

  it("suspender cancela entregas pendientes y reactivar no las reenvía", async () => {
    const created = await request(app).post("/v1/public/hooks/leads").send({
      nombre: "Antes de suspender",
      mensaje: "prueba"
    });
    expect(created.status).toBe(201);
    const delivery = await adminDb().webhookDelivery.findFirstOrThrow({
      where: { endpointId, estado: "pendiente" }, orderBy: { createdAt: "desc" }
    });
    const before = received.length;
    const operator = { userId: superAdminId, rol: "super_admin" as const };

    await setTenantEstado(operator, tenantId, "suspendido");
    expect((await adminDb().webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).estado).toBe("fallida");
    await processDeliveriesOnce();
    expect(received).toHaveLength(before);

    await setTenantEstado(operator, tenantId, "activo");
    const login = await adminA.agent.post("/v1/auth/login")
      .send({ email: adminEmail, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
    adminA.csrf = login.body.csrf_token;
    await processDeliveriesOnce();
    expect(received).toHaveLength(before);
    expect((await adminDb().webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).estado).toBe("fallida");

    const fresh = await request(app).post("/v1/public/hooks/leads").send({
      nombre: "Después de reactivar",
      mensaje: "prueba"
    });
    expect(fresh.status).toBe(201);
    await processDeliveriesOnce();
    expect(received).toHaveLength(before + 1);
  });

  it("el worker descarta una entrega si encuentra el tenant suspendido", async () => {
    const created = await request(app).post("/v1/public/hooks/leads").send({
      nombre: "En cola",
      mensaje: "prueba"
    });
    expect(created.status).toBe(201);
    const delivery = await adminDb().webhookDelivery.findFirstOrThrow({
      where: { endpointId, estado: "pendiente" }, orderBy: { createdAt: "desc" }
    });
    const before = received.length;
    await adminDb().tenant.update({ where: { id: tenantId }, data: { estado: "suspendido" } });
    try {
      await processDeliveriesOnce();
      expect(received).toHaveLength(before);
      expect((await adminDb().webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).estado).toBe("fallida");
    } finally {
      await adminDb().tenant.update({ where: { id: tenantId }, data: { estado: "activo" } });
    }
  });

  it("endpoint desactivado no recibe entregas", async () => {
    const disabled = await adminA.agent
      .patch(`/v1/webhooks/${endpointId}`)
      .set("x-csrf-token", adminA.csrf)
      .send({ activo: false });
    expect(disabled.status).toBe(200);
    const before = received.length;
    const property = await adminA.agent
      .post("/v1/properties")
      .set("x-csrf-token", adminA.csrf)
      .send({ titulo: "Sin hook", operacion: "venta", tipo: "casa", precio: 1 });
    expect(property.status).toBe(201);
    await processDeliveriesOnce();
    expect(received.length).toBe(before);
  });

  it("un agente no puede gestionar webhooks", async () => {
    const A2 = await seedTenantWithUsers("hooks2");
    const agent = request.agent(app);
    const login = await agent
      .post("/v1/auth/login")
      .send({ email: A2.agente.email, password: TEST_PASSWORD });
    const res = await agent
      .post("/v1/webhooks")
      .set("x-csrf-token", login.body.csrf_token)
      .send({ url: receiverUrl, eventos: ["ping"] });
    expect(res.status).toBe(403);
  });
});
