import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import {
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

const post = (a: Agent, csrf: string, url: string, body: object = {}) =>
  a.post(url).set("x-csrf-token", csrf).send(body);
const patch = (a: Agent, csrf: string, url: string, body: object) =>
  a.patch(url).set("x-csrf-token", csrf).send(body);

describe.runIf(DB_AVAILABLE)("Propiedades: CRUD sin fricción e imágenes", () => {
  const app = buildApp();
  let A: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let B: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let agenteA: { agent: Agent; csrf: string };
  let adminA: { agent: Agent; csrf: string };
  let adminB: { agent: Agent; csrf: string };
  let propId = "";

  beforeAll(async () => {
    await truncateAll();
    A = await seedTenantWithUsers("propa");
    B = await seedTenantWithUsers("propb");
    agenteA = await loginAgent(app, A.agente.email);
    adminA = await loginAgent(app, A.admin.email);
    adminB = await loginAgent(app, B.admin.email);
  });

  it("alta rápida: nace disponible, moneda ARS, y visible para public al instante", async () => {
    const res = await post(agenteA.agent, agenteA.csrf, "/v1/properties", {
      titulo: "Casa en el centro",
      operacion: "venta",
      tipo: "casa",
      precio: 120000
    });
    expect(res.status).toBe(201);
    expect(res.body.property.estado).toBe("disponible");
    expect(res.body.property.moneda).toBe("ARS");
    propId = res.body.property.id;

    // Sin fricción: el contexto public (sitio/export) la ve de inmediato.
    const publicas = await runWithContext(
      { rol: "public", tenantId: A.tenant.id },
      (tx) => tx.property.findMany()
    );
    expect(publicas.map((p: { id: string }) => p.id)).toEqual([propId]);
  });

  it("edición completa por el dueño, incluye link de Google Maps", async () => {
    const res = await patch(agenteA.agent, agenteA.csrf, `/v1/properties/${propId}`, {
      descripcion: "3 ambientes, patio",
      zona: "Centro",
      ambientes: 3,
      sup_total: 120.5,
      link_maps: "https://maps.app.goo.gl/abc123"
    });
    expect(res.status).toBe(200);
    expect(res.body.property.zona).toBe("Centro");
    expect(res.body.property.linkMaps).toBe("https://maps.app.goo.gl/abc123");
  });

  it("link_maps inválido devuelve 400", async () => {
    const res = await patch(agenteA.agent, agenteA.csrf, `/v1/properties/${propId}`, {
      link_maps: "no-es-un-link"
    });
    expect(res.status).toBe(400);
  });

  it("otro tenant no ve ni edita la propiedad", async () => {
    const get = await adminB.agent.get(`/v1/properties/${propId}`);
    expect(get.status).toBe(404);
    const upd = await patch(adminB.agent, adminB.csrf, `/v1/properties/${propId}`, {
      titulo: "hackeada"
    });
    expect(upd.status).toBe(404);
    const list = await adminB.agent.get("/v1/properties");
    expect(list.body.meta.total).toBe(0);

    const publicasB = await runWithContext(
      { rol: "public", tenantId: B.tenant.id },
      (tx) => tx.property.findMany()
    );
    expect(publicasB.length).toBe(0);
  });

  it("el admin edita propiedades de sus agentes", async () => {
    const res = await patch(adminA.agent, adminA.csrf, `/v1/properties/${propId}`, {
      ciudad: "Rosario"
    });
    expect(res.status).toBe(200);
  });

  it("filtros y búsqueda", async () => {
    await post(agenteA.agent, agenteA.csrf, "/v1/properties", {
      titulo: "Depto alquiler",
      operacion: "alquiler",
      tipo: "departamento",
      precio: 500
    });
    const list = await agenteA.agent.get("/v1/properties?operacion=alquiler");
    expect(list.body.meta.total).toBe(1);
    const search = await agenteA.agent.get("/v1/properties?q=centro");
    expect(search.body.meta.total).toBe(1);
  });

  it("mine devuelve contadores por estado", async () => {
    const res = await agenteA.agent.get("/v1/properties/mine");
    expect(res.status).toBe(200);
    expect(res.body.contadores.disponible).toBe(2);
  });

  it("cambio de estado comercial en un paso", async () => {
    const res = await patch(agenteA.agent, agenteA.csrf, `/v1/properties/${propId}/estado`, {
      estado: "reservado"
    });
    expect(res.status).toBe(200);
    expect(res.body.property.estado).toBe("reservado");
  });

  it("imágenes: presign respeta el límite y confirm asigna portada", async () => {
    const presign = await post(
      agenteA.agent,
      agenteA.csrf,
      `/v1/properties/${propId}/images/presign`,
      { count: 2 }
    );
    expect(presign.status).toBe(200);
    expect(presign.body.uploads).toHaveLength(2);

    const keys = presign.body.uploads.map((u: { r2_key: string }) => u.r2_key);
    const confirm = await post(
      agenteA.agent,
      agenteA.csrf,
      `/v1/properties/${propId}/images/confirm`,
      { keys }
    );
    expect(confirm.status).toBe(201);
    expect(confirm.body.images[0].esPortada).toBe(true);
    expect(confirm.body.images[1].esPortada).toBe(false);

    const tooMany = await post(
      agenteA.agent,
      agenteA.csrf,
      `/v1/properties/${propId}/images/presign`,
      { count: 19 }
    );
    expect(tooMany.status).toBe(422);
  });

  it("cambiar portada y eliminar promueve la siguiente", async () => {
    const detail = await agenteA.agent.get(`/v1/properties/${propId}`);
    const [img1, img2] = detail.body.property.images;

    const set = await patch(agenteA.agent, agenteA.csrf, `/v1/images/${img2.id}/portada`, {});
    expect(set.status).toBe(200);
    expect(set.body.image.esPortada).toBe(true);

    const del = await agenteA.agent
      .delete(`/v1/images/${img2.id}`)
      .set("x-csrf-token", agenteA.csrf);
    expect(del.status).toBe(200);

    const after = await agenteA.agent.get(`/v1/properties/${propId}`);
    expect(after.body.property.images).toHaveLength(1);
    expect(after.body.property.images[0].id).toBe(img1.id);
    expect(after.body.property.images[0].esPortada).toBe(true);
  });

  it("eliminar propiedad borra también sus imágenes", async () => {
    const del = await agenteA.agent
      .delete(`/v1/properties/${propId}`)
      .set("x-csrf-token", agenteA.csrf);
    expect(del.status).toBe(200);
    const get = await agenteA.agent.get(`/v1/properties/${propId}`);
    expect(get.status).toBe(404);
  });

  it("el admin carga campos de alquiler y filtra por dormitorios", async () => {
    const nueva = await post(adminA.agent, adminA.csrf, "/v1/properties", {
      titulo: "Depto alquiler 2 dorm",
      operacion: "alquiler",
      tipo: "departamento",
      precio: 250000
    });
    expect(nueva.status).toBe(201);
    const alqId = nueva.body.property.id;

    const upd = await patch(adminA.agent, adminA.csrf, `/v1/properties/${alqId}`, {
      dormitorios: 2,
      destino: "vivienda",
      plazo_contrato: "meses_24",
      ajuste: "trimestral",
      indice_ajuste: "fijo",
      indice_fijo_pct: 10,
      expensas: "incluidas",
      mascotas: "se_permiten",
      amoblado: "sin_amoblar"
    });
    expect(upd.status).toBe(200);
    expect(upd.body.property.destino).toBe("vivienda");
    expect(upd.body.property.plazoContrato).toBe("meses_24");
    expect(upd.body.property.indiceAjuste).toBe("fijo");
    expect(upd.body.property.mascotas).toBe("se_permiten");

    // Filtro por dormitorios (mínimo): 2 la trae, 3 no.
    const dosDorm = await adminA.agent.get("/v1/properties?dormitorios=2");
    expect(dosDorm.body.data.some((p: { id: string }) => p.id === alqId)).toBe(true);
    const tresDorm = await adminA.agent.get("/v1/properties?dormitorios=3");
    expect(tresDorm.body.data.some((p: { id: string }) => p.id === alqId)).toBe(false);
  });

  it("operacion 'ambos' aparece en venta y en alquiler, y guarda el precio de alquiler", async () => {
    const created = await post(agenteA.agent, agenteA.csrf, "/v1/properties", {
      titulo: "Casa venta y alquiler",
      operacion: "ambos",
      tipo: "casa",
      precio: 200000
    });
    expect(created.status).toBe(201);
    const id = created.body.property.id as string;
    await patch(agenteA.agent, agenteA.csrf, `/v1/properties/${id}`, {
      precio_alquiler: 1500,
      moneda_alquiler: "USD"
    });

    // El filtro por operación incluye "ambos" en los dos lados.
    const enVenta = await agenteA.agent.get("/v1/properties?operacion=venta");
    expect(enVenta.body.data.some((p: { id: string }) => p.id === id)).toBe(true);
    const enAlquiler = await agenteA.agent.get("/v1/properties?operacion=alquiler");
    expect(enAlquiler.body.data.some((p: { id: string }) => p.id === id)).toBe(true);

    const detalle = await agenteA.agent.get(`/v1/properties/${id}`);
    expect(Number(detalle.body.property.precioAlquiler)).toBe(1500);
    expect(detalle.body.property.monedaAlquiler).toBe("USD");
  });

  it("destacar es solo admin: un agente lo tiene prohibido incluso en su propia propiedad", async () => {
    const propia = await post(agenteA.agent, agenteA.csrf, "/v1/properties", {
      titulo: "Propia del agente",
      operacion: "venta",
      tipo: "casa",
      precio: 5000,
    });
    const id = propia.body.property.id as string;
    const rPatch = await patch(agenteA.agent, agenteA.csrf, `/v1/properties/${id}/destacada`, {
      destacada: true,
    });
    expect(rPatch.status).toBe(403);
    // destacada ni existe en el PATCH general: único camino es /destacada.
    const rUpdate = await patch(agenteA.agent, agenteA.csrf, `/v1/properties/${id}`, {
      destacada: true,
    });
    expect(rUpdate.status).toBe(400);
    expect((await agenteA.agent.get(`/v1/properties/${id}`)).body.property.destacada).toBe(false);
  });

  it("un admin tampoco puede destacar colgado del PATCH general (solo por /destacada)", async () => {
    const propia = await post(adminA.agent, adminA.csrf, "/v1/properties", {
      titulo: "Del admin",
      operacion: "venta",
      tipo: "casa",
      precio: 5000,
    });
    const id = propia.body.property.id as string;
    const rUpdate = await patch(adminA.agent, adminA.csrf, `/v1/properties/${id}`, {
      destacada: true,
    });
    expect(rUpdate.status).toBe(400);
    expect((await adminA.agent.get(`/v1/properties/${id}`)).body.property.destacada).toBe(false);
  });

  it("destacar respeta el tope único de 12 por tenant (no por vendedor)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await post(agenteA.agent, agenteA.csrf, "/v1/properties", {
        titulo: `Destacada ${i}`,
        operacion: "venta",
        tipo: "casa",
        precio: 1000 + i,
      });
      ids.push(r.body.property.id as string);
    }
    // El admin puede destacar las 12, sin importar quién sea el dueño.
    for (const id of ids) {
      const r = await patch(adminA.agent, adminA.csrf, `/v1/properties/${id}/destacada`, {
        destacada: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.property.destacada).toBe(true);
    }
    // La 13ª es rechazada por el tope del tenant (422 LIMIT_EXCEEDED).
    const trece = await post(agenteA.agent, agenteA.csrf, "/v1/properties", {
      titulo: "Destacada 13",
      operacion: "venta",
      tipo: "casa",
      precio: 9999,
    });
    const treceId = trece.body.property.id as string;
    const rechazo = await patch(adminA.agent, adminA.csrf, `/v1/properties/${treceId}/destacada`, {
      destacada: true,
    });
    expect(rechazo.status).toBe(422);
    // Al liberar una, la 13ª ya se puede destacar.
    await patch(adminA.agent, adminA.csrf, `/v1/properties/${ids[0]}/destacada`, {
      destacada: false,
    });
    const ok = await patch(adminA.agent, adminA.csrf, `/v1/properties/${treceId}/destacada`, {
      destacada: true,
    });
    expect(ok.status).toBe(200);
    // Limpieza: no dejar las 12 destacadas afectando otros tests del archivo.
    for (const id of [...ids, treceId]) {
      await patch(adminA.agent, adminA.csrf, `/v1/properties/${id}/destacada`, {
        destacada: false,
      });
    }
  });
  it("guarda referencia y sugiere ubicaciones solo del tenant, combinando zona vacía y búsqueda", async () => {
    const created = await post(agenteA.agent, agenteA.csrf, "/v1/properties", {
      titulo: "Referencia singular", operacion: "venta", tipo: "casa", precio: 100
    });
    const id = created.body.property.id;
    const updated = await patch(agenteA.agent, agenteA.csrf, `/v1/properties/${id}`, {
      zona: "Zona propia A", ciudad: "Ciudad propia A", punto_referencia: "Frente a la plaza"
    });
    expect(updated.status).toBe(200);
    expect(updated.body.property.puntoReferencia).toBe("Frente a la plaza");
    const own = await agenteA.agent.get("/v1/properties/locations");
    expect(own.status).toBe(200);
    expect(own.body.zonas).toContain("Zona propia A");
    expect(own.body.ciudades).toContain("Ciudad propia A");
    const other = await adminB.agent.get("/v1/properties/locations");
    expect(other.body.zonas).not.toContain("Zona propia A");
    expect(other.body.ciudades).not.toContain("Ciudad propia A");
    const filtered = await adminA.agent.get("/v1/properties?zona_revisar=true&q=Referencia%20singular");
    expect(filtered.body.meta.total).toBe(0);
    await patch(agenteA.agent, agenteA.csrf, `/v1/properties/${id}`, { zona: null });
    const missing = await adminA.agent.get("/v1/properties?zona_revisar=true&q=Referencia%20singular");
    expect(missing.body.data.map((p: { id: string }) => p.id)).toEqual([id]);
    expect((await request(app).get("/v1/properties/locations")).status).toBe(401);
  });

});
