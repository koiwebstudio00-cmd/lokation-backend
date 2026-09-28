import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  adminDb,
  DB_AVAILABLE,
  seedTenantWithUsers,
  TEST_PASSWORD,
  truncateAll
} from "./helpers.js";

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: ReturnType<typeof buildApp>, email: string) {
  const agent = request.agent(app);
  const res = await agent.post("/v1/auth/login").send({ email, password: TEST_PASSWORD });
  return { agent, csrf: res.body.csrf_token as string };
}

describe.runIf(DB_AVAILABLE)("Export (API keys)", () => {
  const app = buildApp();
  let A: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let B: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let adminA: { agent: Agent; csrf: string };
  let agenteA: { agent: Agent; csrf: string };
  let adminB: { agent: Agent; csrf: string };
  let keyA = "";
  let keyAId = "";
  let keyB = "";
  let propId = "";
  let propSlug = "";

  beforeAll(async () => {
    await truncateAll();
    A = await seedTenantWithUsers("expa");
    B = await seedTenantWithUsers("expb");
    adminA = await loginAgent(app, A.admin.email);
    agenteA = await loginAgent(app, A.agente.email);
    adminB = await loginAgent(app, B.admin.email);

    // Propiedad con un campo interno (notas) para el test anti-fuga
    const prop = await agenteA.agent
      .post("/v1/properties")
      .set("x-csrf-token", agenteA.csrf)
      .send({ titulo: "Depto céntrico", operacion: "venta", tipo: "departamento", precio: 80000 });
    propId = prop.body.property.id;
    await agenteA.agent
      .patch(`/v1/properties/${propId}`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ zona: "Centro", ambientes: 3, notas: "dato interno confidencial" });
  });

  it("el admin crea una key: completa una sola vez, listado solo con prefix", async () => {
    const res = await adminA.agent
      .post("/v1/api-keys")
      .set("x-csrf-token", adminA.csrf)
      .send({ nombre: "Sitio Lamelas" });
    expect(res.status).toBe(201);
    keyA = res.body.key;
    keyAId = res.body.api_key.id;
    expect(keyA.startsWith("ilk_")).toBe(true);

    const list = await adminA.agent.get("/v1/api-keys");
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].prefix).toBe(keyA.slice(0, 12));
    expect(JSON.stringify(list.body)).not.toContain(keyA);

    const b = await adminB.agent
      .post("/v1/api-keys")
      .set("x-csrf-token", adminB.csrf)
      .send({ nombre: "Sitio B" });
    keyB = b.body.key;
  });

  it("el agente no puede gestionar keys", async () => {
    const res = await agenteA.agent
      .post("/v1/api-keys")
      .set("x-csrf-token", agenteA.csrf)
      .send({ nombre: "no debería" });
    expect(res.status).toBe(403);
  });

  it("lista propiedades del tenant sin campos internos (anti-fuga)", async () => {
    const res = await request(app).get("/v1/export/properties").set("x-api-key", keyA);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0].titulo).toBe("Depto céntrico");
    expect(res.body.data[0].estado).toBe("disponible");
    // slug con la misma fórmula que el MVP (0010): {operacion}-{titulo}-{id_corto}
    expect(res.body.data[0].slug).toMatch(/^venta-depto-centrico-[0-9a-f]{8}$/);
    propSlug = res.body.data[0].slug;

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("notas");
    expect(raw).not.toContain("confidencial");
    expect(raw).not.toContain("userId");
    expect(raw).not.toContain("tenantId");
  });

  it("ficha con galería, también sin fuga", async () => {
    const res = await request(app)
      .get(`/v1/export/properties/${propId}`)
      .set("x-api-key", keyA);
    expect(res.status).toBe(200);
    expect(res.body.property.titulo).toBe("Depto céntrico");
    expect(Array.isArray(res.body.property.images)).toBe(true);

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("notas");
    expect(raw).not.toContain("userId");
    expect(raw).not.toContain("tenantId");
  });

  it("la ficha también resuelve por slug (URLs de la web pública)", async () => {
    const res = await request(app)
      .get(`/v1/export/properties/${propSlug}`)
      .set("x-api-key", keyA);
    expect(res.status).toBe(200);
    expect(res.body.property.id).toBe(propId);
    expect(res.body.property.titulo).toBe("Depto céntrico");
  });

  it("/export/site devuelve los datos públicos de la inmobiliaria", async () => {
    const res = await request(app).get("/v1/export/site").set("x-api-key", keyA);
    expect(res.status).toBe(200);
    expect(res.body.site.nombre).toBe("Inmo expa");
    expect(res.body.site.slug).toBe("expa");
  });

  it("filtros: operacion, ambientes mínimos y updated_since", async () => {
    const alquiler = await request(app)
      .get("/v1/export/properties?operacion=alquiler")
      .set("x-api-key", keyA);
    expect(alquiler.body.meta.total).toBe(0);

    const ambientes = await request(app)
      .get("/v1/export/properties?ambientes=2")
      .set("x-api-key", keyA);
    expect(ambientes.body.meta.total).toBe(1);

    const futuro = await request(app)
      .get("/v1/export/properties?updated_since=2030-01-01T00:00:00Z")
      .set("x-api-key", keyA);
    expect(futuro.body.meta.total).toBe(0);
  });

  it("filtros y orden que consume la web: estado, dormitorios, sort y ciudades", async () => {
    // La primera propiedad pasa a tener ciudad y dormitorios para poder filtrar.
    await agenteA.agent
      .patch(`/v1/properties/${propId}`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ ciudad: "Balcarce", dormitorios: 3 });

    // Segunda propiedad: más barata, otra ciudad y reservado.
    const otra = await agenteA.agent
      .post("/v1/properties")
      .set("x-csrf-token", agenteA.csrf)
      .send({ titulo: "Casa con patio", operacion: "venta", tipo: "casa", precio: 50000 });
    const otraId = otra.body.property.id as string;
    await agenteA.agent
      .patch(`/v1/properties/${otraId}`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ ciudad: "Mar del Plata", dormitorios: 2 });
    await agenteA.agent
      .patch(`/v1/properties/${otraId}/estado`)
      .set("x-csrf-token", agenteA.csrf)
      .send({ estado: "reservado" });

    // estado: el sitio público lista solo las disponibles
    const disponibles = await request(app)
      .get("/v1/export/properties?estado=disponible")
      .set("x-api-key", keyA);
    expect(disponibles.body.meta.total).toBe(1);
    expect(disponibles.body.data[0].id).toBe(propId);

    // dormitorios_min es un mínimo, no una igualdad
    const dorms = await request(app)
      .get("/v1/export/properties?dormitorios_min=3")
      .set("x-api-key", keyA);
    expect(dorms.body.meta.total).toBe(1);
    expect(dorms.body.data[0].titulo).toBe("Depto céntrico");

    // sort por precio (el precio viaja como string: es numeric en la BD)
    const asc = await request(app)
      .get("/v1/export/properties?sort=price-asc")
      .set("x-api-key", keyA);
    expect(asc.body.data.map((p: { titulo: string }) => p.titulo)).toEqual([
      "Casa con patio",
      "Depto céntrico"
    ]);
    expect(Number(asc.body.data[0].precio)).toBe(50000);

    const desc = await request(app)
      .get("/v1/export/properties?sort=price-desc")
      .set("x-api-key", keyA);
    expect(desc.body.data[0].titulo).toBe("Depto céntrico");

    // ciudades para el filtro del sitio, alfabéticas y sin repetir
    const todas = await request(app).get("/v1/export/ciudades").set("x-api-key", keyA);
    expect(todas.status).toBe(200);
    expect(todas.body.data).toEqual(["Balcarce", "Mar del Plata"]);

    const soloDisponibles = await request(app)
      .get("/v1/export/ciudades?estado=disponible")
      .set("x-api-key", keyA);
    expect(soloDisponibles.body.data).toEqual(["Balcarce"]);

    // zonas para el filtro del sitio, espejo de ciudades (solo propId tiene zona)
    const zonas = await request(app).get("/v1/export/zonas").set("x-api-key", keyA);
    expect(zonas.status).toBe(200);
    expect(zonas.body.data).toEqual(["Centro"]);

    const zonasDisponibles = await request(app)
      .get("/v1/export/zonas?estado=disponible")
      .set("x-api-key", keyA);
    expect(zonasDisponibles.body.data).toEqual(["Centro"]);
  });

  it("la key de otro tenant no ve nada del primero", async () => {
    const res = await request(app).get("/v1/export/properties").set("x-api-key", keyB);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(0);
  });

  it("sin key o con key falsa: 401", async () => {
    const sin = await request(app).get("/v1/export/properties");
    expect(sin.status).toBe(401);

    const falsa = await request(app)
      .get("/v1/export/properties")
      .set("x-api-key", "ilk_00000000000000000000000000000000000000000000000&");
    expect(falsa.status).toBe(401);
  });

  it("key revocada deja de operar", async () => {
    const del = await adminA.agent
      .delete(`/v1/api-keys/${keyAId}`)
      .set("x-csrf-token", adminA.csrf);
    expect(del.status).toBe(204);

    const res = await request(app).get("/v1/export/properties").set("x-api-key", keyA);
    expect(res.status).toBe(401);

    const list = await adminA.agent.get("/v1/api-keys");
    expect(list.body.data).toHaveLength(0);
  });

  it("tenant suspendido: la key no opera", async () => {
    await adminDb().tenant.update({
      where: { id: B.tenant.id },
      data: { estado: "suspendido" }
    });
    const res = await request(app).get("/v1/export/properties").set("x-api-key", keyB);
    expect(res.status).toBe(403);
  });
});
