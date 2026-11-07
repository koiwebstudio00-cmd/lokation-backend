import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Bóveda independiente y tareas", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: typeof a;
  const admin = request.agent(app), other = request.agent(app), agent = request.agent(app);
  let csrf: string, csrfOther: string, csrfAgent: string;
  beforeAll(async () => {
    await truncateAll(); a = await seedTenantWithUsers("vault-a"); b = await seedTenantWithUsers("vault-b");
    csrf = (await admin.post("/v1/auth/login").send({ email: a.admin.email, password: TEST_PASSWORD })).body.csrf_token;
    csrfOther = (await other.post("/v1/auth/login").send({ email: b.admin.email, password: TEST_PASSWORD })).body.csrf_token;
    csrfAgent = (await agent.post("/v1/auth/login").send({ email: a.agente.email, password: TEST_PASSWORD })).body.csrf_token;
  });
  it("sube una foto privada sin contrato, descarga y elimina sin acceso cruzado", async () => {
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=", "base64");
    const created = await admin.post("/v1/rental-documents?title=Foto%20privada&kind=inventario&originalName=entrega.png")
      .set("x-csrf-token", csrf).set("Content-Type", "application/octet-stream").send(bytes);
    expect(created.status).toBe(201);
    const id = created.body.document.id;
    expect(created.body.document.mimeType).toBe("image/png");
    const list = await admin.get("/v1/rental-documents?q=Foto");
    expect(list.body.data[0].contractId).toBeNull();
    expect(list.body.data[0].visibility).toBe("interna");
    expect(list.body.data[0].storageKey).toBeUndefined();
    const downloaded = await admin.get(`/v1/rental-documents/${id}/content?preview=1`);
    expect(downloaded.status).toBe(200); expect(downloaded.headers["content-type"]).toContain("image/png");
    expect(Buffer.from(downloaded.body)).toEqual(bytes);
    expect((await other.get(`/v1/rental-documents/${id}/content`)).status).toBe(404);
    expect((await other.delete(`/v1/rental-documents/${id}`).set("x-csrf-token", csrfOther)).status).toBe(404);
    expect((await agent.get(`/v1/rental-documents/${id}/content`)).status).toBe(404);
    expect((await admin.delete(`/v1/rental-documents/${id}`).set("x-csrf-token", csrf)).status).toBe(200);
    expect((await admin.get(`/v1/rental-documents/${id}/content`)).status).toBe(404);
  });
  it("rechaza archivos activos disfrazados de foto", async () => {
    const result = await admin.post("/v1/rental-documents?title=Foto%20falsa&kind=otro&originalName=foto.png")
      .set("x-csrf-token", csrf).set("Content-Type", "application/octet-stream").send(Buffer.from("<svg onload='alert(1)'></svg>"));
    expect(result.status).toBe(400);
  });
  it("asigna tareas del tenant, restringe agentes y permite completar y reasignar", async () => {
    const body = { title: "Revisar entrega", assignedToId: a.agente.id, dueDate: "2026-11-10", priority: "alta" };
    const created = await admin.post("/v1/tasks").set("x-csrf-token", csrf).send(body);
    expect(created.status).toBe(201); const id = created.body.task.id;
    expect((await agent.get("/v1/tasks")).body.data[0].id).toBe(id);
    expect((await other.get("/v1/tasks")).body.data).toEqual([]);
    expect((await agent.patch(`/v1/tasks/${id}`).set("x-csrf-token", csrfAgent).send({ status: "completada" })).status).toBe(200);
    expect((await agent.patch(`/v1/tasks/${id}`).set("x-csrf-token", csrfAgent).send({ assignedToId: a.admin.id })).status).toBe(400);
    expect((await other.patch(`/v1/tasks/${id}`).set("x-csrf-token", csrfOther).send({ status: "cancelada" })).status).toBe(404);
    expect((await admin.post("/v1/tasks").set("x-csrf-token", csrf).send({ ...body, assignedToId: b.agente.id })).status).toBe(400);
    expect((await agent.post("/v1/tasks").set("x-csrf-token", csrfAgent).send(body)).status).toBe(403);
    await expect(runWithContext({ tenantId: a.tenant.id, userId: a.agente.id, rol: "agente" }, tx => tx.teamTask.update({ where: { id }, data: { title: "Cambio prohibido" } }))).rejects.toThrow();
    await expect(runWithContext({ tenantId: a.tenant.id, userId: a.admin.id, rol: "admin" }, tx => tx.teamTask.update({ where: { id }, data: { assignedToId: b.agente.id } }))).rejects.toThrow();
    expect((await admin.patch(`/v1/tasks/${id}`).set("x-csrf-token", csrf).send({ assignedToId: a.admin.id, status: "en_curso" })).status).toBe(200);
    expect((await agent.get("/v1/tasks")).body.data).toEqual([]);
    expect((await agent.patch(`/v1/tasks/${id}`).set("x-csrf-token", csrfAgent).send({ status: "completada" })).status).toBe(404);
  });
});
