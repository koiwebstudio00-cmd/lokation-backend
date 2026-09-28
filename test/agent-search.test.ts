import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";
import { identityTerms, normalizeSearchText, resolvePropertyType, zoneAlternatives } from "../src/modules/agent/property-search.js";
import { runWithContext } from "../src/lib/prisma.js";

describe("Normalizacion de busqueda", () => {
  it("normaliza acentos, tipos y referencias sin inventar alturas", () => {
    expect(normalizeSearchText(" Muñecas, 660 ")).toBe("munecas 660");
    expect(resolvePropertyType("local")).toBe("local_comercial");
    expect(resolvePropertyType("monoambiente")).toBe("monoambiente");
    expect(resolvePropertyType("dpto")).toBe("departamento");
    expect(resolvePropertyType("castillo")).toBeUndefined();
    expect(identityTerms("departamento 3 dormitorios en Muñecas 650")).toEqual(["munecas", "650"]);
  });

  it("separa alternativas explicitas sin partir nombres de barrios ni expandir abreviaturas", () => {
    expect(zoneAlternatives("Barrio Norte o Centro")).toEqual(["Barrio Norte", "Centro"]);
    expect(zoneAlternatives("centro", ["Barrio Norte, CENTRO", "Villa Luján o Villa Lujan"]))
      .toEqual(["Barrio Norte", "CENTRO", "Villa Luján"]);
    expect(zoneAlternatives("Ojo de Agua")).toEqual(["Ojo de Agua"]);
    expect(zoneAlternatives("Norte y Sur")).toEqual(["Norte y Sur"]);
    expect(zoneAlternatives()).toEqual([]);
  });
});

describe.runIf(DB_AVAILABLE)("Busqueda e identificacion del agente con RLS", () => {
  const app = buildApp();
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let key = "", keyB = "", exportKey = "";
  let target = "", far = "", mono = "", sold = "";

  beforeAll(async () => {
    await truncateAll();
    a = await seedTenantWithUsers("search-a");
    await adminDb().tenant.update({ where: { id: a.tenant.id }, data: { configSitio: { url_publica: "https://inmobiliarialyc.com.ar" } } });
    const b = await seedTenantWithUsers("search-b");
    for (const [tenant, assign] of [[a, (value: string) => { key = value; }], [b, (value: string) => { keyB = value; }]] as const) {
      const session = request.agent(app);
      const login = await session.post("/v1/auth/login").send({ email: tenant.admin.email, password: TEST_PASSWORD });
      const created = await session.post("/v1/integrations/api-keys").set("x-csrf-token", login.body.csrf_token)
        .send({ nombre: "search", scopes: ["agent:read", "agent:write"] });
      expect(created.status).toBe(201);
      assign(created.body.key);
      if (tenant === a) {
        const external = await session.post("/v1/integrations/api-keys").set("x-csrf-token", login.body.csrf_token)
          .send({ nombre: "export", scopes: ["export:read"] });
        exportKey = external.body.key;
      }
    }
    const base = { tenantId: a.tenant.id, userId: a.admin.id, ciudad: "San Miguel de Tucumán", notas: "SECRET_INTERNAL_PRICE" };
    target = (await adminDb().property.create({ data: { ...base, titulo: "Semipiso tres dormitorios", direccion: "Muñecas 660", zona: "Barrio Norte",
      tipo: "departamento", operacion: "ambos", precio: 90000, moneda: "USD", precioAlquiler: 800000, monedaAlquiler: "ARS", dormitorios: 3, ambientes: 4,
      mascotas: "se_permiten", amoblado: "sin_amoblar", expensas: "$250.000 aprox.", slug: "alquiler-semipiso-search" } })).id;
    far = (await adminDb().property.create({ data: { ...base, titulo: "Departamento de un dormitorio", direccion: "Muñecas 6600", zona: "Barrio Sur",
      tipo: "departamento", operacion: "alquiler", precio: 700000, moneda: "ARS", dormitorios: 1, ambientes: 2,
      mascotas: "no_se_permiten", amoblado: "amoblado", slug: "alquiler-depto-search" } })).id;
    mono = (await adminDb().property.create({ data: { ...base, titulo: "Monoambiente", direccion: "Muñecas 662", zona: "Barrio Norte",
      tipo: "monoambiente", operacion: "alquiler", precio: 600, moneda: "USD", dormitorios: 0, ambientes: 1, estado: "privado", slug: "alquiler-mono-search" } })).id;
    sold = (await adminDb().property.create({ data: { ...base, titulo: "Casa vendida", direccion: "Rondeau 550", zona: "Barrio Sur",
      tipo: "casa", operacion: "venta", precio: 50000, moneda: "USD", estado: "vendida", slug: "venta-casa-search" } })).id;
    await adminDb().property.create({ data: { tenantId: b.tenant.id, userId: b.admin.id, titulo: "SECRET_OTHER_TENANT", direccion: "Muñecas 660",
      ciudad: "Ciudad reservada B", zona: "Zona exclusiva B", tipo: "departamento", operacion: "venta", precio: 1, slug: "venta-secret-b" } });
  });

  const search = (query: Record<string, string | number | string[]> = {}) => request(app).get("/v1/agent/properties").query(query).set("x-api-key", key);
  const identify = (referencia: string, apiKey = key) => request(app).get("/v1/agent/properties/identify").query({ referencia }).set("x-api-key", apiKey);

  it("busca por palabras y sin acentos, sin confundir 660 con 6600", async () => {
    const res = await search({ q: "depto en munecas 660" });
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([target]);
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET|tenantId|tenant_id|userId|notas/);
  });

  it("usa alquiler en ambos y respeta moneda y orden", async () => {
    const res = await search({ operacion: "alquiler", moneda: "ARS", precio_min: 750000, precio_max: 850000, sort: "price-asc" });
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([target]);
    expect(res.body.data[0].precio_consulta).toBe(800000);
    expect(res.body.data[0].moneda_consulta).toBe("ARS");
    expect(res.body.meta.advertencias.join(" ")).toContain("no incluye expensas");
    const sale = await search({ operacion: "venta", moneda: "USD", precio_max: 100000 });
    expect(sale.body.data[0].id).toBe(target);
    expect(sale.body.data[0].precio_consulta).toBe(90000);
    const ordered = await search({ operacion: "alquiler", moneda: "ARS", sort: "price-asc" });
    expect(ordered.body.data.map((p: { id: string }) => p.id)).toEqual([far, target]);
  });

  it("filtra varias zonas, mascotas, amoblado y rango de dormitorios sin relajar requisitos", async () => {
    const res = await search({ zonas: "Barrio Norte,Barrio Sur", dormitorios_min: 2, dormitorios_max: 3, mascotas: "se_permiten", amoblado: "sin_amoblar" });
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([target]);
    const none = await search({ dormitorios_min: 3, mascotas: "no_se_permiten" });
    expect(none.body.meta.total).toBe(0);
  });

  it("excluye descartes antes de contar y paginar; monoambiente no es un dormitorio", async () => {
    const excluded = await search({ excluir_ids: target, excluir_slugs: "alquiler-depto-search", limit: 1 });
    expect(excluded.body.meta.total).toBe(1);
    expect(excluded.body.data[0].id).toBe(mono);
    const exact = await search({ tipo: "monoambiente", ambientes_exactos: 1 });
    expect(exact.body.data.map((p: { id: string }) => p.id)).toEqual([mono]);
    const legacy = await search({ ambientes: 2 });
    expect(legacy.body.meta.total).toBe(2);
  });

  it("mantiene compatibilidad del tipo desconocido con advertencia y valida filtros nuevos", async () => {
    const res = await search({ tipo: "castillo" });
    expect(res.status).toBe(200);
    expect(res.body.meta.advertencias.join(" ")).toContain("Tipo no reconocido");
    for (const params of [{ excluir_ids: "not-uuid" }, { moneda: "EUR" }, { precio_min: 10, precio_max: 1 }, { dormitorios_min: 3, dormitorios_max: 1 }]) {
      expect((await search(params)).status).toBe(400);
    }
  });

  it("identifica direccion, slug, id y URL propia sin abrir URLs", async () => {
    for (const reference of ["Muñecas 660", "muneca 660", "alquiler-semipiso-search", target, "https://inmobiliarialyc.com.ar/propiedades/alquiler-semipiso-search?utm_source=ig"]) {
      const res = await identify(reference);
      expect(res.status).toBe(200);
      expect(res.body.resultado, reference).toBe("identificada");
      expect(res.body.propiedad.id).toBe(target);
    }
    const external = await identify("https://instagram.com/p/example");
    expect(external.body.resultado).toBe("no_identificada");
  });

  it("no confirma alturas aproximadas, distintas ni calles incompletas", async () => {
    for (const reference of ["Muñecas 650", "Muñecas al 600", "Muñecas", "660"]) {
      const res = await identify(reference);
      expect(res.body.resultado).toBe("ambigua");
      expect(res.body.propiedad).toBeNull();
    }
    expect((await identify("Calle inexistente 999")).body.resultado).toBe("no_identificada");
  });

  it("dos unidades en la misma direccion requieren aclarar, aunque el estado sea distinto", async () => {
    const duplicate = await adminDb().property.create({ data: { tenantId: a.tenant.id, userId: a.admin.id, titulo: "Otra unidad", direccion: "Muñecas 660", tipo: "departamento", operacion: "venta", precio: 1, estado: "vendida", slug: "venta-other-unit" } });
    try {
      const res = await identify("Muñecas 660");
      expect(res.body.resultado).toBe("ambigua");
      expect(res.body.total).toBe(2);
    } finally { await adminDb().property.delete({ where: { id: duplicate.id } }); }
  });

  it("identifica una vendida para informar estado sin ofrecerla en busquedas", async () => {
    const res = await identify(sold);
    expect(res.body.propiedad.estado).toBe("vendida");
    expect((await search({ q: "Rondeau 550" })).body.meta.total).toBe(0);
  });

  it("catalogo, identificacion y busqueda no exponen otro tenant ni campos internos", async () => {
    expect((await identify(target, keyB)).body.resultado).toBe("no_identificada");
    expect((await identify("venta-secret-b")).body.resultado).toBe("no_identificada");
    for (const path of ["/v1/agent/properties/identify?referencia=Munecas%20660", "/v1/agent/properties/catalog", "/v1/agent/properties"]) {
      const res = await request(app).get(path).set("x-api-key", key);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(/SECRET|exclusiva B|reservada B|tenantId|user_id|notas/);
      expect((await request(app).get(path).set("x-api-key", exportKey)).status).toBe(403);
    }
  });

  it("RLS permite al agente leer solo su tenant, sin modificarlo ni ampliar acceso publico", async () => {
    await runWithContext({ rol: "agent", tenantId: a.tenant.id }, async (tx) => {
      const tenants = await tx.tenant.findMany({ select: { id: true, configSitio: true } });
      expect(tenants).toEqual([{ id: a.tenant.id, configSitio: { url_publica: "https://inmobiliarialyc.com.ar" } }]);
      expect((await tx.tenant.updateMany({ data: { nombre: "UNAUTHORIZED" } })).count).toBe(0);
    });
    const publicRows = await runWithContext({ rol: "public", tenantId: a.tenant.id }, (tx) => tx.tenant.findMany());
    expect(publicRows).toEqual([]);
    const noContextRows = await runWithContext({ rol: "agent" }, (tx) => tx.tenant.findMany());
    expect(noContextRows).toEqual([]);
  });

  it("contexto incluye ubicaciones del tenant y no permite leer otra conversacion", async () => {
    const created = await request(app).post("/v1/agent/conversations").set("x-api-key", key)
      .send({ canal: "web", canal_ref: "search-context" });
    expect(created.status).toBe(201);
    const path = `/v1/agent/conversations/${created.body.conversation.id}/context`;
    const context = await request(app).get(path).set("x-api-key", key);
    expect(context.status).toBe(200);
    expect(context.body.catalogo_propiedades.tipos).toContain("monoambiente");
    expect(context.body.catalogo_propiedades.ubicaciones).toEqual([
      { ciudad: "San Miguel de Tucumán", zona: "Barrio Norte" },
      { ciudad: "San Miguel de Tucumán", zona: "Barrio Sur" }
    ]);
    expect((await request(app).get(path).set("x-api-key", keyB)).status).toBe(404);
  });

  it("encuentra las variantes de Barrio Norte solo en la ciudad confirmada y conserva filtros", async () => {
    const b = await adminDb().tenant.findUniqueOrThrow({ where: { slug: "search-b" } });
    const bUser = await adminDb().user.findFirstOrThrow({ where: { tenantId: b.id } });
    const base = { tenantId: a.tenant.id, userId: a.admin.id, ciudad: "San Miguel de Tucumán",
      tipo: "departamento", operacion: "alquiler", dormitorios: 3, precio: 1050000, moneda: "ARS",
      mascotas: "se_permiten", notas: "SECRET_ZONE" };
    const fixtures = [
      { titulo: "SEMI PISO EN ALQUILER", zona: "ZON NORTE", precio: 2000000 },
      { titulo: "BARRIO NORTE 3 DORMITORIOS MONTEAGUDO 500", zona: "Norte" },
      { titulo: "Departamento en barrio norte", zona: "Barrio norte", estado: "reservado", precio: 850000 },
      { titulo: "Centro", zona: "Centro" },
      { titulo: "Otra ciudad", zona: "Norte", ciudad: "Yerba Buena" },
      { titulo: "Otro barrio", zona: "Lomas del Norte" },
      { titulo: "Ciudad sin especificar", zona: "Norte", ciudad: null },
      { titulo: "Barrio Norte otra ciudad literal", zona: "Barrio Norte", ciudad: "Yerba Buena" },
      { titulo: "SECRET_OTHER_TENANT", zona: "Norte", tenantId: b.id, userId: bUser.id },
      { titulo: "Otro dormitorio", zona: "Norte", dormitorios: 4 }
    ];
    const ids: string[] = [];
    try {
      for (const fixture of fixtures) ids.push((await adminDb().property.create({ data: { ...base, ...fixture } })).id);
      const filters = { operacion: "alquiler", tipo: "departamento", dormitorios_min: 3, dormitorios_max: 3, ciudad: "San Miguel de Tucuman" };
      for (const zona of ["Barrio Norte", "Norte", "ZON NORTE"]) {
        const res = await search({ ...filters, zona });
        expect(res.status).toBe(200);
        expect(res.body.data.map((p: { id: string }) => p.id).sort()).toEqual([target, ids[0], ids[1]].sort());
        expect(res.body.meta.total).toBe(3);
        expect(JSON.stringify(res.body)).not.toContain("SECRET");
      }
      const withoutCity = await search({ zona: "Barrio Norte", operacion: "alquiler", tipo: "departamento", dormitorios_min: 3, dormitorios_max: 3 });
      expect(withoutCity.body.data.map((p: { id: string }) => p.id).sort()).toEqual([target, ids[0], ids[1], ids[7]].sort());
      const otherCity = await search({ ...filters, ciudad: "Yerba Buena", zona: "Barrio Norte" });
      expect(otherCity.body.data.map((p: { id: string }) => p.id)).toEqual([ids[7]]);
      for (const params of [{ zona: "Barrio Norte o Centro" }, { zonas: "Barrio Norte,Centro" }, { zonas: ["Barrio Norte", "Centro"] }]) {
        const res = await search({ ...filters, ...params });
        expect(res.status).toBe(200);
        expect(res.body.data.map((p: { id: string }) => p.id).sort()).toEqual([target, ids[0], ids[1], ids[3]].sort());
        expect(res.body.meta.filtros_aplicados.zonas).toEqual(["Barrio Norte", "Centro"]);
      }
      const narrowed = await search({ ...filters, zona: "Barrio Norte", moneda: "ARS", precio_max: 1100000, excluir_ids: target, limit: 1 });
      expect(narrowed.body.data.map((p: { id: string }) => p.id)).toEqual([ids[1]]);
      expect(narrowed.body.meta.total).toBe(1);
      expect((await search({ ...filters, zona: "Barrio Norte", mascotas: "no_se_permiten" })).body.meta.total).toBe(0);
    } finally {
      await adminDb().property.deleteMany({ where: { id: { in: ids } } });
    }
  });

  it("valida el limite de zonas despues de separar y combinar ambos parametros", async () => {
    const zones = Array.from({ length: 11 }, (_, i) => `Zona ${i}`);
    expect((await search({ zona: zones.join(" o ") })).status).toBe(400);
    expect((await search({ zona: zones[10]!, zonas: zones.slice(0, 10) })).status).toBe(400);
    expect((await search({ zona: " , " })).status).toBe(400);
  });

  it("ordena empates por ID antes de limitar el historial, sin mezclar conversaciones", async () => {
    const create = (ref: string, apiKey: string) => request(app).post("/v1/agent/conversations")
      .set("x-api-key", apiKey).send({ canal: "web", canal_ref: ref });
    const first = await create("history-order", key);
    const other = await create("history-order-other", key);
    const foreign = await create("history-order-b", keyB);
    expect(first.status).toBe(201);
    expect(other.status).toBe(201);
    expect(foreign.status).toBe(201);
    const foreignConv = await adminDb().conversation.findUniqueOrThrow({ where: { id: foreign.body.conversation.id } });
    const base = { tenantId: a.tenant.id, conversationId: first.body.conversation.id, rol: "agente_ia" as const,
      createdAt: new Date("2026-08-30T23:39:00Z") };
    await adminDb().conversationMessage.createMany({ data: [
      { ...base, id: 100003n, contenido: "Si mandame el link", rol: "lead" },
      { ...base, id: 100001n, contenido: "Rondeau 398" },
      { ...base, id: 100002n, contenido: "Buenos Aires 662. Queres el link?" },
      { ...base, id: 100004n, contenido: "Anterior aunque ID mayor", createdAt: new Date("2026-08-30T23:38:00Z") },
      { ...base, id: 100005n, contenido: "Otra conversacion", conversationId: other.body.conversation.id },
      { ...base, id: 100006n, contenido: "SECRET_OTHER_TENANT", tenantId: foreignConv.tenantId, conversationId: foreignConv.id }
    ] });
    for (const k of [1, 2, 3, 4]) {
      const res = await request(app).get(`/v1/agent/conversations/${first.body.conversation.id}/context`)
        .query({ k }).set("x-api-key", key);
      expect(res.status).toBe(200);
      expect(res.body.mensajes.map((m: { id: string }) => m.id)).toEqual(["100004", "100001", "100002", "100003"].slice(-k));
      expect(JSON.stringify(res.body)).not.toContain("SECRET");
    }
  });
});
