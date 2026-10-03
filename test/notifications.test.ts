import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { adminDb, DB_AVAILABLE, seedSuperAdmin, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";
describe.runIf(DB_AVAILABLE)("Notificaciones personales", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let b: typeof a;
  let operator: Awaited<ReturnType<typeof seedSuperAdmin>>;
  const admin = request.agent(app), seller = request.agent(app), other = request.agent(app), platform = request.agent(app);
  let csrf = "", sellerCsrf = "", id = "";
  beforeAll(async () => {
    await truncateAll(); operator = await seedSuperAdmin();
    a = await seedTenantWithUsers("notifications-a"); b = await seedTenantWithUsers("notifications-b");
    for (const [client,email] of [[admin,a.admin.email],[seller,a.agente.email],[other,b.admin.email],[platform,operator.email]] as const) {
      const login = await client.post("/v1/auth/login").send({ email, password: TEST_PASSWORD });
      if (client === admin) csrf = login.body.csrf_token;
      if (client === seller) sellerCsrf = login.body.csrf_token;
    }
    for (let n=0;n<7;n++) await adminDb().lead.create({ data: { tenantId:a.tenant.id,canal:"web",nombre:`Test ${n}`,mensaje:"consulta" } });
    await adminDb().lead.create({ data: { tenantId:b.tenant.id,canal:"web",nombre:"Otro",mensaje:"privado" } });
  });
  it("lista últimas cinco, conteo total y contador sin leer", async () => {
    const res = await admin.get("/v1/notifications?limit=5");
    expect(res.status).toBe(200); expect(res.body.items).toHaveLength(5); expect(res.body.total).toBe(7); expect(res.body.unread).toBe(7);
    expect(res.body.items.every((n: {userId: string;tenantId: string}) => n.userId===a.admin.id && n.tenantId===a.tenant.id)).toBe(true); id=res.body.items[0].id;
    expect((await other.get("/v1/notifications")).body.total).toBe(1);
    expect((await seller.get("/v1/notifications")).body.total).toBe(0);
  });
  it("autenticación y CSRF obligatorios", async () => {
    expect((await request(app).get("/v1/notifications")).status).toBe(401);
    expect((await admin.patch(`/v1/notifications/${id}/read`).send({})).status).toBe(403);
  });
  it("no permite leer ni marcar notificaciones ajenas incluso dentro del tenant", async () => {
    expect((await seller.patch(`/v1/notifications/${id}/read`).set("x-csrf-token",sellerCsrf).send({})).status).toBe(404);
    for (const ctx of [{userId:a.agente.id,tenantId:a.tenant.id,rol:"agente" as const},{userId:b.admin.id,tenantId:b.tenant.id,rol:"admin" as const},{userId:operator.id,rol:"super_admin" as const}]) {
      expect(await runWithContext(ctx,tx=>tx.notification.findUnique({where:{id}}))).toBe(null);
      expect((await runWithContext(ctx,tx=>tx.notification.updateMany({where:{id},data:{readAt:new Date()}}))).count).toBe(0);
    }
  });
  it("lectura idempotente y marcar todas conserva historial", async () => {
    for(let n=0;n<2;n++) expect((await admin.patch(`/v1/notifications/${id}/read`).set("x-csrf-token",csrf).send({})).status).toBe(200);
    expect((await admin.get("/v1/notifications")).body.unread).toBe(6);
    await admin.patch("/v1/notifications/read-all").set("x-csrf-token",csrf).send({});
    const res=await admin.get("/v1/notifications");expect(res.body.unread).toBe(0);expect(res.body.total).toBe(7);
  });
  it("asignación notifica sólo al nuevo responsable y excluye probador IA", async () => {
    const lead=await adminDb().lead.findFirstOrThrow({where:{tenantId:a.tenant.id}});
    await adminDb().lead.update({where:{id:lead.id},data:{assignedTo:a.agente.id}});
    expect((await seller.get("/v1/notifications")).body.total).toBe(1);
    await adminDb().lead.update({where:{id:lead.id},data:{assignedTo:a.agente.id}});
    expect((await seller.get("/v1/notifications")).body.total).toBe(1);
    await adminDb().lead.create({data:{tenantId:a.tenant.id,canal:"web",canalRef:"prueba-test",nombre:"Prueba",mensaje:"test"}});
    expect((await admin.get("/v1/notifications")).body.total).toBe(7);
  });
  it("publicación notifica admins; plataforma sólo recibe información de inmobiliarias", async () => {
    await adminDb().tenant.update({where:{id:a.tenant.id},data:{sitePublished:true}});
    expect((await admin.get("/v1/notifications")).body.items[0].href).toBe("/mi-sitio");
    const res=await platform.get("/v1/notifications");expect(res.body.total).toBe(3);
    expect(res.body.items.every((n:{tenantId:string|null;href:string})=>n.tenantId===null && n.href.startsWith("/inmobiliarias/"))).toBe(true);
  });
  it("una operación revertida no deja notificaciones", async () => {
    const count=await adminDb().notification.count();
    await expect(adminDb().$transaction(async tx=>{await tx.lead.create({data:{tenantId:a.tenant.id,canal:"manual",nombre:"Rollback",mensaje:"test"}});throw new Error("rollback");})).rejects.toThrow("rollback");
    expect(await adminDb().notification.count()).toBe(count);
  });
});
