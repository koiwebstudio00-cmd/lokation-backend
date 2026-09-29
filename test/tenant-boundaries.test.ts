import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

type Agent = ReturnType<typeof request.agent>;

describe.runIf(DB_AVAILABLE)("Aislamiento HTTP entre inmobiliarias", () => {
  const app = buildApp();
  let A: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let B: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let adminA: { agent: Agent; csrf: string };
  let adminB: { agent: Agent; csrf: string };
  let keyA = "";
  let keyB = "";
  let propertyId = "";
  let propertySlug = "";
  let imageId = "";
  let conversationId = "";
  let channelId = "";

  beforeAll(async () => {
    await truncateAll();
    A = await seedTenantWithUsers("boundary-a");
    B = await seedTenantWithUsers("boundary-b");

    const login = async (email: string) => {
      const agent = request.agent(app);
      const response = await agent.post("/v1/auth/login").send({ email, password: TEST_PASSWORD });
      expect(response.status).toBe(200);
      return { agent, csrf: response.body.csrf_token as string };
    };
    adminA = await login(A.admin.email);
    adminB = await login(B.admin.email);

    const makeKey = async (session: { agent: Agent; csrf: string }) => {
      const response = await session.agent
        .post("/v1/integrations/api-keys")
        .set("x-csrf-token", session.csrf)
        .send({ nombre: "Sitio de prueba", scopes: ["export:read", "agent:read"] });
      expect(response.status).toBe(201);
      return response.body.key as string;
    };
    keyA = await makeKey(adminA);
    keyB = await makeKey(adminB);

    const property = await adminDb().property.create({
      data: {
        tenantId: B.tenant.id,
        userId: B.agente.id,
        titulo: "Casa privada de B",
        operacion: "venta",
        tipo: "casa",
        precio: 100000,
        ciudad: "Tucumán"
      }
    });
    propertyId = property.id;
    propertySlug = property.slug;
    const image = await adminDb().propertyImage.create({
      data: {
        tenantId: B.tenant.id,
        propertyId,
        r2Key: `${B.tenant.id}/${propertyId}/foto.webp`,
        url: "https://example.test/foto.webp",
        esPortada: true,
        orden: 0
      }
    });
    imageId = image.id;

    const lead = await adminDb().lead.create({
      data: { tenantId: B.tenant.id, nombre: "Lead B", canal: "whatsapp", mensaje: "Consulta" }
    });
    conversationId = (await adminDb().conversation.create({
      data: {
        tenantId: B.tenant.id,
        leadId: lead.id,
        canal: "whatsapp",
        canalRef: "5493810000000"
      }
    })).id;
    channelId = (await adminDb().channelAccount.create({
      data: {
        tenantId: B.tenant.id,
        canal: "whatsapp",
        zernioProfileId: "boundary-profile-b",
        zernioAccountId: "boundary-account-b",
        conectadaPor: B.admin.id
      }
    })).id;
  });

  it("la API pública no expone la ficha ni el sitio de B con la key de A", async () => {
    for (const identifier of [propertyId, propertySlug]) {
      const foreign = await request(app)
        .get(`/v1/export/properties/${identifier}`)
        .set("x-api-key", keyA);
      const own = await request(app)
        .get(`/v1/export/properties/${identifier}`)
        .set("x-api-key", keyB);
      expect(foreign.status).toBe(404);
      expect(own.status).toBe(200);
      expect(own.body.property.id).toBe(propertyId);
    }

    const listA = await request(app).get("/v1/export/properties").set("x-api-key", keyA);
    const listB = await request(app).get("/v1/export/properties").set("x-api-key", keyB);
    expect(listA.body.meta.total).toBe(0);
    expect(listB.body.meta.total).toBe(1);
    const siteA = await request(app).get("/v1/export/site").set("x-api-key", keyA);
    const siteB = await request(app).get("/v1/export/site").set("x-api-key", keyB);
    expect(siteA.body.site.slug).toBe(A.tenant.slug);
    expect(siteB.body.site.slug).toBe(B.tenant.slug);
  });

  it("A no puede subir, confirmar, reordenar ni modificar fotos de B", async () => {
    const propertyPath = `/v1/properties/${propertyId}/images`;
    const presign = await adminA.agent
      .post(`${propertyPath}/presign`)
      .set("x-csrf-token", adminA.csrf)
      .send({ count: 1 });
    expect(presign.status).toBe(404);

    const confirm = await adminA.agent
      .post(`${propertyPath}/confirm`)
      .set("x-csrf-token", adminA.csrf)
      .send({ keys: [`${B.tenant.id}/${propertyId}/intruso.webp`] });
    expect(confirm.status).toBe(404);

    const order = await adminA.agent
      .patch(`${propertyPath}/order`)
      .set("x-csrf-token", adminA.csrf)
      .send({ ids: [imageId] });
    expect(order.status).toBe(404);

    const cover = await adminA.agent
      .patch(`/v1/images/${imageId}/portada`)
      .set("x-csrf-token", adminA.csrf)
      .send({});
    expect(cover.status).toBe(404);

    const remove = await adminA.agent
      .delete(`/v1/images/${imageId}`)
      .set("x-csrf-token", adminA.csrf);
    expect(remove.status).toBe(404);

    const own = await adminB.agent.get(`/v1/properties/${propertyId}`);
    expect(own.status).toBe(200);
    expect(own.body.property.images.map((image: { id: string }) => image.id)).toContain(imageId);
  });

  it("A no puede leer ni tomar conversaciones de B", async () => {
    const listA = await adminA.agent.get("/v1/conversations");
    const listB = await adminB.agent.get("/v1/conversations");
    expect(listA.body.meta.total).toBe(0);
    expect(listB.body.meta.total).toBe(1);

    const messagesA = await adminA.agent.get(`/v1/conversations/${conversationId}/messages`);
    const messagesB = await adminB.agent.get(`/v1/conversations/${conversationId}/messages`);
    expect(messagesA.status).toBe(404);
    expect(messagesB.status).toBe(200);

    const contextA = await request(app)
      .get(`/v1/agent/conversations/${conversationId}/context`)
      .set("x-api-key", keyA);
    const contextB = await request(app)
      .get(`/v1/agent/conversations/${conversationId}/context`)
      .set("x-api-key", keyB);
    expect(contextA.status).toBe(404);
    expect(contextB.status).toBe(200);

    for (const action of ["take", "release"]) {
      const response = await adminA.agent
        .post(`/v1/conversations/${conversationId}/${action}`)
        .set("x-csrf-token", adminA.csrf)
        .send({});
      expect(response.status).toBe(404);
    }
    expect((await adminDb().conversation.findUniqueOrThrow({ where: { id: conversationId } })).tenantId)
      .toBe(B.tenant.id);
  });

  it("A no puede consultar ni desconectar el canal de B", async () => {
    const listA = await adminA.agent.get("/v1/integrations/channels");
    const listB = await adminB.agent.get("/v1/integrations/channels");
    expect(listA.body.data).toHaveLength(0);
    expect(listB.body.data.map((channel: { id: string }) => channel.id)).toContain(channelId);

    const health = await adminA.agent.get(`/v1/integrations/channels/${channelId}/health`);
    expect(health.status).toBe(404);
    const disconnect = await adminA.agent
      .delete(`/v1/integrations/channels/${channelId}`)
      .set("x-csrf-token", adminA.csrf);
    expect(disconnect.status).toBe(404);
    expect((await adminDb().channelAccount.findUniqueOrThrow({ where: { id: channelId } })).estado)
      .toBe("activa");
  });

  it("A no puede cambiar el rol, estado ni contraseña de un usuario de B", async () => {
    const role = await adminA.agent
      .patch(`/v1/users/${B.agente.id}`)
      .set("x-csrf-token", adminA.csrf)
      .send({ rol: "admin", estado: "inactivo" });
    expect(role.status).toBe(404);
    const password = await adminA.agent
      .post(`/v1/users/${B.agente.id}/password`)
      .set("x-csrf-token", adminA.csrf)
      .send({ new_password: "unaClaveNueva123", notify: false });
    expect(password.status).toBe(404);
    const own = await adminB.agent.get("/v1/users");
    expect(own.body.data.find((user: { id: string }) => user.id === B.agente.id))
      .toMatchObject({ rol: "agente", estado: "activo" });
  });

  it("un ID de otro tenant responde igual que uno inexistente", async () => {
    const absent = randomUUID();
    const pairs = [
      [
        () => adminA.agent.get(`/v1/properties/${propertyId}`),
        () => adminA.agent.get(`/v1/properties/${absent}`)
      ],
      [
        () => adminA.agent.get(`/v1/conversations/${conversationId}/messages`),
        () => adminA.agent.get(`/v1/conversations/${absent}/messages`)
      ],
      [
        () => adminA.agent.get(`/v1/integrations/channels/${channelId}/health`),
        () => adminA.agent.get(`/v1/integrations/channels/${absent}/health`)
      ]
    ] as const;
    for (const [foreign, missing] of pairs) {
      const [foreignResponse, missingResponse] = await Promise.all([foreign(), missing()]);
      expect(foreignResponse.status).toBe(404);
      expect(foreignResponse.body).toEqual(missingResponse.body);
      expect(foreignResponse.body.error).toMatchObject({
        code: "NOT_FOUND",
        message: "El recurso no existe."
      });
    }
  });
});
