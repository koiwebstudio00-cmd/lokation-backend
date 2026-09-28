import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  adminDb,
  DB_AVAILABLE,
  seedSuperAdmin,
  seedTenantWithUsers,
  TEST_PASSWORD,
  truncateAll
} from "./helpers.js";

type Agent = ReturnType<typeof request.agent>;

async function login(app: ReturnType<typeof buildApp>, email: string) {
  const agent = request.agent(app);
  const res = await agent.post("/v1/auth/login").send({ email, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  return { agent, csrf: res.body.csrf_token as string };
}

describe.runIf(DB_AVAILABLE)("Feedback (sugerencias y reportes)", () => {
  const app = buildApp();
  let A: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let B: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let adminA: { agent: Agent; csrf: string };
  let agenteA: { agent: Agent; csrf: string };
  let otroAgenteA: { agent: Agent; csrf: string };
  let adminB: { agent: Agent; csrf: string };
  let superA: { agent: Agent; csrf: string };

  let sugerenciaId = "";
  let reporteId = "";

  beforeAll(async () => {
    await truncateAll();
    A = await seedTenantWithUsers("fdbk-a");
    B = await seedTenantWithUsers("fdbk-b");
    await seedSuperAdmin();

    // Un segundo agente en A, para probar que un agente no ve lo de su colega.
    await adminDb().user.create({
      data: {
        nombre: "Otro agente A",
        email: "otro@fdbk-a.test",
        passwordHash: A.agente.passwordHash,
        rol: "agente",
        tenantId: A.tenant.id
      }
    });

    adminA = await login(app, A.admin.email);
    agenteA = await login(app, A.agente.email);
    otroAgenteA = await login(app, "otro@fdbk-a.test");
    adminB = await login(app, B.admin.email);
    superA = await login(app, "super@test.test");
  });

  it("un agente crea una sugerencia y un reporte, y los ve", async () => {
    const sug = await agenteA.agent
      .post("/v1/feedback")
      .set("x-csrf-token", agenteA.csrf)
      .send({ tipo: "sugerencia", titulo: "Agregar filtro por zona", descripcion: "Estaría bueno filtrar." });
    expect(sug.status).toBe(201);
    expect(sug.body.item.tipo).toBe("sugerencia");
    expect(sug.body.item.estado).toBe("nuevo");
    sugerenciaId = sug.body.item.id;

    const rep = await agenteA.agent
      .post("/v1/feedback")
      .set("x-csrf-token", agenteA.csrf)
      .send({
        tipo: "error",
        titulo: "El botón no responde",
        descripcion: "Al guardar no pasa nada.",
        url_contexto: "/propiedades/nueva"
      });
    expect(rep.status).toBe(201);
    reporteId = rep.body.item.id;

    const lista = await agenteA.agent.get("/v1/feedback");
    expect(lista.body.meta.total).toBe(2);
  });

  it("filtra por tipo", async () => {
    const soloSug = await agenteA.agent.get("/v1/feedback?tipo=sugerencia");
    expect(soloSug.body.meta.total).toBe(1);
    expect(soloSug.body.data[0].id).toBe(sugerenciaId);
  });

  it("un agente NO ve el feedback de otro agente del mismo tenant", async () => {
    const lista = await otroAgenteA.agent.get("/v1/feedback");
    expect(lista.body.meta.total).toBe(0);

    const detalle = await otroAgenteA.agent.get(`/v1/feedback/${reporteId}`);
    expect(detalle.status).toBe(404);
  });

  it("el admin del tenant ve todo el feedback de su inmobiliaria", async () => {
    const lista = await adminA.agent.get("/v1/feedback");
    expect(lista.body.meta.total).toBe(2);
  });

  it("el admin de otro tenant no lo ve (aislamiento)", async () => {
    const lista = await adminB.agent.get("/v1/feedback");
    expect(lista.body.meta.total).toBe(0);

    const detalle = await adminB.agent.get(`/v1/feedback/${reporteId}`);
    expect(detalle.status).toBe(404);
  });

  it("el super_admin ve el feedback de todos los tenants", async () => {
    const lista = await superA.agent.get("/v1/feedback");
    expect(lista.body.meta.total).toBe(2);
  });

  it("el agente no puede cambiar el estado; el admin sí", async () => {
    const prohibido = await agenteA.agent
      .patch(`/v1/feedback/${sugerenciaId}`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ estado: "en_revision" });
    expect(prohibido.status).toBe(403);

    const ok = await adminA.agent
      .patch(`/v1/feedback/${sugerenciaId}`)
      .set("x-csrf-token", adminA.csrf)
      .send({ estado: "planificada" });
    expect(ok.status).toBe(200);
    expect(ok.body.item.estado).toBe("planificada");
  });

  it("cualquiera que ve el ítem puede comentar; el super_admin también", async () => {
    const delAgente = await agenteA.agent
      .post(`/v1/feedback/${reporteId}/comentarios`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ cuerpo: "Me pasa en Chrome." });
    expect(delAgente.status).toBe(201);

    const delSuper = await superA.agent
      .post(`/v1/feedback/${reporteId}/comentarios`)
      .set("x-csrf-token", superA.csrf)
      .send({ cuerpo: "Lo miramos desde Koi." });
    expect(delSuper.status).toBe(201);

    const detalle = await adminA.agent.get(`/v1/feedback/${reporteId}`);
    expect(detalle.body.item.comentarios).toHaveLength(2);
  });

  it("adjuntos: presign + confirm en un reporte; el prefijo se valida", async () => {
    const presign = await agenteA.agent
      .post(`/v1/feedback/${reporteId}/adjuntos/presign`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ count: 2 });
    expect(presign.status).toBe(200);
    expect(presign.body.uploads).toHaveLength(2);
    const keys = presign.body.uploads.map((u: { r2_key: string }) => u.r2_key);

    const confirm = await agenteA.agent
      .post(`/v1/feedback/${reporteId}/adjuntos/confirm`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ keys });
    expect(confirm.status).toBe(201);
    expect(confirm.body.adjuntos).toHaveLength(2);

    // Una key que no corresponde al reporte se rechaza.
    const mala = await agenteA.agent
      .post(`/v1/feedback/${reporteId}/adjuntos/confirm`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ keys: ["otro-tenant/feedback/x/y.webp"] });
    expect(mala.status).toBe(400);
  });

  it("las sugerencias no aceptan imágenes", async () => {
    const res = await agenteA.agent
      .post(`/v1/feedback/${sugerenciaId}/adjuntos/presign`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ count: 1 });
    expect(res.status).toBe(400);
  });

  it("el admin borra un reporte (cascade limpia adjuntos y comentarios)", async () => {
    const del = await adminA.agent
      .delete(`/v1/feedback/${reporteId}`)
      .set("x-csrf-token", adminA.csrf);
    expect(del.status).toBe(204);

    const adjuntos = await adminDb().feedbackAdjunto.count({ where: { feedbackId: reporteId } });
    expect(adjuntos).toBe(0);
    const comentarios = await adminDb().feedbackComentario.count({ where: { feedbackId: reporteId } });
    expect(comentarios).toBe(0);

    const lista = await adminA.agent.get("/v1/feedback");
    expect(lista.body.meta.total).toBe(1);
  });
});
