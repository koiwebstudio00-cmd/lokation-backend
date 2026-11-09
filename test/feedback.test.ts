import request from "supertest";
import { runWithContext } from "../src/lib/prisma.js";
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
  let communityB: { agent: Agent; csrf: string };
  let superA: { agent: Agent; csrf: string };

  let sugerenciaId = "";
  let reporteId = "";

  beforeAll(async () => {
    await truncateAll();
    A = await seedTenantWithUsers("fdbk-a");
    B = await seedTenantWithUsers("fdbk-b");
    await seedSuperAdmin();

    // Un segundo agente en A, para probar la lectura compartida entre colegas.
    await adminDb().user.create({
      data: {
        nombre: "Otro agente A",
        email: "otro@fdbk-a.test",
        passwordHash: A.agente.passwordHash,
        rol: "agente",
        tenantId: A.tenant.id
      }
    });

    await adminDb().user.create({data:{nombre:"Community B",email:"community@fdbk-b.test",passwordHash:B.agente.passwordHash,rol:"community",tenantId:B.tenant.id}});
    communityB = await login(app,"community@fdbk-b.test");
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

  it("community participa entre inmobiliarias y RLS impide moderar incluso por SQL", async () => {
    const list = await communityB.agent.get("/v1/feedback").expect(200);
    expect(list.body.meta.total).toBe(2);
    await communityB.agent.post(`/v1/feedback/${sugerenciaId}/comentarios`).set("x-csrf-token",communityB.csrf).send({cuerpo:"Idea compartida desde B"}).expect(201);
    const detail = await agenteA.agent.get(`/v1/feedback/${sugerenciaId}`).expect(200);
    expect(detail.body.item.comentarios[0].autor.nombre).toBe("Community B");
    const ctx = {rol:"admin" as const,tenantId:A.tenant.id,userId:A.admin.id};
    expect(await runWithContext(ctx,tx=>tx.feedbackItem.updateMany({where:{id:sugerenciaId},data:{estado:"resuelta"}}))).toEqual({count:0});
    expect(await runWithContext(ctx,tx=>tx.feedbackItem.deleteMany({where:{id:sugerenciaId}}))).toEqual({count:0});
    expect(await runWithContext(ctx,tx=>tx.user.findUnique({where:{id:B.admin.id}}))).toBeNull();
  });

  it("filtra por tipo", async () => {
    const soloSug = await agenteA.agent.get("/v1/feedback?tipo=sugerencia");
    expect(soloSug.body.meta.total).toBe(1);
    expect(soloSug.body.data[0].id).toBe(sugerenciaId);
  });

  it("un agente ve el feedback de otro agente del mismo tenant", async () => {
    const lista = await otroAgenteA.agent.get("/v1/feedback");
    expect(lista.body.meta.total).toBe(2);

    const detalle = await otroAgenteA.agent.get(`/v1/feedback/${reporteId}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body.item.autor.nombre).toBe(A.agente.nombre);
  });

  it("el admin del tenant ve todo el feedback de su inmobiliaria", async () => {
    const lista = await adminA.agent.get("/v1/feedback");
    expect(lista.body.meta.total).toBe(2);
  });

  it("el admin de otro tenant puede leer", async () => {
    const lista = await adminB.agent.get("/v1/feedback");
    expect(lista.body.meta.total).toBe(2);

    const detalle = await adminB.agent.get(`/v1/feedback/${reporteId}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body.item.autor.nombre).toBe(A.agente.nombre);
  });

  it("el super_admin ve el feedback de todos los tenants", async () => {
    const lista = await superA.agent.get("/v1/feedback");
    expect(lista.body.meta.total).toBe(2);
  });

  it("solo el superadmin puede cambiar el estado", async () => {
    const prohibido = await agenteA.agent
      .patch(`/v1/feedback/${sugerenciaId}`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ estado: "en_revision" });
    expect(prohibido.status).toBe(403);

    await adminA.agent.patch(`/v1/feedback/${sugerenciaId}`).set("x-csrf-token", adminA.csrf).send({estado:"resuelta"}).expect(403);
    const ok = await superA.agent
      .patch(`/v1/feedback/${sugerenciaId}`)
      .set("x-csrf-token", superA.csrf)
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
    await adminB.agent.post(`/v1/feedback/${reporteId}/comentarios`).set("x-csrf-token",adminB.csrf).send({cuerpo:"También sucede en otra inmobiliaria"}).expect(201);
    const shared = await agenteA.agent.get(`/v1/feedback/${reporteId}`);
    expect(shared.body.item.comentarios.at(-1).autor.nombre).toBe(B.admin.nombre);
    expect((await adminB.agent.get(`/v1/feedback/${reporteId}`)).body.item.urlContexto).toBeNull();
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

  it("protege adjuntos ajenos y requiere sesión", async () => {
    for (const user of [adminA, adminB, otroAgenteA]) {
      await user.agent.post(`/v1/feedback/${reporteId}/adjuntos/presign`).set("x-csrf-token",user.csrf).send({count:1}).expect(403);
    }
    const item = (await adminB.agent.get(`/v1/feedback/${reporteId}`)).body.item;
    expect(item.adjuntos).toHaveLength(2);
    await adminB.agent.delete(`/v1/feedback/adjuntos/${item.adjuntos[0].id}`).set("x-csrf-token",adminB.csrf).expect(404);
    await request(app).get("/v1/feedback").expect(401);
  });

  it("las sugerencias no aceptan imágenes", async () => {
    const res = await agenteA.agent
      .post(`/v1/feedback/${sugerenciaId}/adjuntos/presign`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ count: 1 });
    expect(res.status).toBe(400);
  });

  it("el superadmin borra un reporte (cascade limpia adjuntos y comentarios)", async () => {
    await adminA.agent.delete(`/v1/feedback/${reporteId}`).set("x-csrf-token",adminA.csrf).expect(403);
    const del = await superA.agent
      .delete(`/v1/feedback/${reporteId}`)
      .set("x-csrf-token", superA.csrf);
    expect(del.status).toBe(204);

    const adjuntos = await adminDb().feedbackAdjunto.count({ where: { feedbackId: reporteId } });
    expect(adjuntos).toBe(0);
    const comentarios = await adminDb().feedbackComentario.count({ where: { feedbackId: reporteId } });
    expect(comentarios).toBe(0);

    const lista = await adminA.agent.get("/v1/feedback");
    expect(lista.body.meta.total).toBe(1);
  });
});
