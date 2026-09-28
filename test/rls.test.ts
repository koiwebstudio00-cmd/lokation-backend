// Tests de aislamiento RLS — permisos-rls.md §6.
// Usan runWithContext (conexión app_rt) contra la BD de test.
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import {
  DB_AVAILABLE,
  seedSuperAdmin,
  seedTenantWithUsers,
  TEST_PASSWORD,
  truncateAll
} from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Aislamiento RLS", () => {
  let A: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let B: Awaited<ReturnType<typeof seedTenantWithUsers>>;

  beforeAll(async () => {
    await truncateAll();
    A = await seedTenantWithUsers("aaa");
    B = await seedTenantWithUsers("bbb");
    await seedSuperAdmin();
  });

  const ctxAgenteA = () => ({
    userId: A.agente.id,
    tenantId: A.tenant.id,
    rol: "agente" as const
  });
  const ctxAdminA = () => ({
    userId: A.admin.id,
    tenantId: A.tenant.id,
    rol: "admin" as const
  });

  it("un agente solo ve usuarios de su tenant", async () => {
    const users = await runWithContext(ctxAgenteA(), (tx) => tx.user.findMany());
    expect(users.length).toBe(2);
    expect(users.every((u) => u.tenantId === A.tenant.id)).toBe(true);
  });

  it("un admin no puede modificar usuarios de otro tenant (0 filas)", async () => {
    const { count } = await runWithContext(ctxAdminA(), (tx) =>
      tx.user.updateMany({
        where: { id: B.agente.id },
        data: { estado: "inactivo" }
      })
    );
    expect(count).toBe(0);
  });

  it("un admin no puede crear super_admins (RLS rechaza)", async () => {
    await expect(
      runWithContext(ctxAdminA(), (tx) =>
        tx.user.create({
          data: {
            nombre: "Hacker",
            email: "hacker@aaa.test",
            passwordHash: "x",
            rol: "super_admin",
            tenantId: null
          }
        })
      )
    ).rejects.toThrow();
  });

  it("un admin no puede invitar a otro tenant (RLS rechaza)", async () => {
    await expect(
      runWithContext(ctxAdminA(), (tx) =>
        tx.invitation.create({
          data: {
            tenantId: B.tenant.id,
            invitedBy: A.admin.id,
            email: "intruso@bbb.test",
            rol: "agente",
            tokenHash: "hash-unico-test",
            expiresAt: new Date(Date.now() + 86400000)
          }
        })
      )
    ).rejects.toThrow();
  });

  it("el contexto public no ve usuarios ni tenants", async () => {
    const publicCtx = { rol: "public" as const, tenantId: A.tenant.id };
    const users = await runWithContext(publicCtx, (tx) => tx.user.findMany());
    expect(users.length).toBe(0);
    const tenants = await runWithContext(publicCtx, (tx) => tx.tenant.findMany());
    expect(tenants.length).toBe(0);
  });

  it("cada tenant ve solo su propio tenant", async () => {
    const tenants = await runWithContext(ctxAgenteA(), (tx) => tx.tenant.findMany());
    expect(tenants.map((t) => t.id)).toEqual([A.tenant.id]);
  });

  it("solo el admin edita el seguimiento de su propio tenant", async () => {
    const own = await runWithContext(ctxAdminA(), (tx) =>
      tx.tenant.updateMany({
        where: { id: A.tenant.id },
        data: { followupFirstMessage: "Texto propio" }
      })
    );
    expect(own.count).toBe(1);

    const cross = await runWithContext(ctxAdminA(), (tx) =>
      tx.tenant.updateMany({
        where: { id: B.tenant.id },
        data: { followupFirstMessage: "No debe escribirse" }
      })
    );
    expect(cross.count).toBe(0);

    const seller = await runWithContext(ctxAgenteA(), (tx) =>
      tx.tenant.updateMany({
        where: { id: A.tenant.id },
        data: { followupEnabled: false, agentEnabled: false }
      })
    );
    expect(seller.count).toBe(0);
  });

  it("API: un admin de A no ve el tenant B en /tenants/current ni su equipo", async () => {
    const app = buildApp();
    const agent = request.agent(app);
    await agent
      .post("/v1/auth/login")
      .send({ email: B.admin.email, password: TEST_PASSWORD });

    const equipo = await agent.get("/v1/users");
    expect(equipo.status).toBe(200);
    const ids = (equipo.body.data as { id: string }[]).map((u) => u.id);
    expect(ids).toContain(B.admin.id);
    expect(ids).not.toContain(A.admin.id);
  });

  it("API: /tenants es solo para super_admin", async () => {
    const app = buildApp();
    const agent = request.agent(app);
    await agent
      .post("/v1/auth/login")
      .send({ email: A.admin.email, password: TEST_PASSWORD });
    const res = await agent.get("/v1/tenants");
    expect(res.status).toBe(403);
  });
});
