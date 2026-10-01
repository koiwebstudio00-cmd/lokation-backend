import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import {
  TIPOS,
  ESTADOS,
  DESTINOS,
  PLAZOS,
  AJUSTES,
  INDICES,
  MASCOTAS,
  AMOBLADO
} from "../../lib/property-opciones.js";
import * as props from "./service.js";

export const propertyRoutes = Router();

propertyRoutes.use("/properties", requireAuth, requireRole("admin", "agente"));

const tipoEnum = z.enum(TIPOS);
const estadoEnum = z.enum(ESTADOS);

const filtersSchema = z.object({
  operacion: z.enum(["venta", "alquiler"]).optional(),
  tipo: tipoEnum.optional(),
  estado: estadoEnum.optional(),
  vendedor: z.string().uuid().optional(),
  dormitorios: z.coerce.number().int().min(0).optional(),
  q: z.string().trim().min(1).optional(),
  // Propiedades con la zona pendiente de completar.
  zona_revisar: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(props.PAGE_SIZE)
});

const idParam = () => z.string().uuid();

function parseFilters(query: unknown): props.PropertyFilters {
  const { zona_revisar, ...rest } = filtersSchema.parse(query);
  return {
    ...rest,
    ...(zona_revisar !== undefined ? { zonaRevisar: zona_revisar === "true" } : {})
  };
}

propertyRoutes.get("/properties", async (req, res) => {
  res.json(await props.listProperties(req.auth!, parseFilters(req.query)));
});

propertyRoutes.get("/properties/mine", async (req, res) => {
  res.json(await props.myProperties(req.auth!, parseFilters(req.query)));
});

// Campos de alquiler (opcionales en create y update). En BD son texto; acá se
// valida contra el set canónico. Los "_otro"/pct acompañan a "otro"/"fijo".
const alquilerFields = {
  destino: z.enum(DESTINOS).nullable().optional(),
  plazo_contrato: z.enum(PLAZOS).nullable().optional(),
  plazo_otro: z.string().trim().max(200).nullable().optional(),
  ajuste: z.enum(AJUSTES).nullable().optional(),
  ajuste_otro: z.string().trim().max(200).nullable().optional(),
  indice_ajuste: z.enum(INDICES).nullable().optional(),
  indice_fijo_pct: z.coerce.number().min(0).max(999.99).nullable().optional(),
  expensas: z.string().trim().max(200).nullable().optional(),
  mascotas: z.enum(MASCOTAS).nullable().optional(),
  amoblado: z.enum(AMOBLADO).nullable().optional(),
  // Precio de alquiler: solo aplica cuando operacion=ambos (o alquiler puro, que
  // usa `precio`). Nullable: se vacía si deja de ser "ambos".
  precio_alquiler: z.coerce.number().nonnegative().nullable().optional(),
  moneda_alquiler: z.enum(["ARS", "USD"]).nullable().optional(),
  lat: z.coerce.number().min(-90).max(90).nullable().optional(),
  lng: z.coerce.number().min(-180).max(180).nullable().optional()
};

const createSchema = z.object({
  titulo: z.string().trim().min(1, "El título es obligatorio."),
  operacion: z.enum(["venta", "alquiler", "ambos"]),
  tipo: tipoEnum,
  precio: z.coerce.number().nonnegative("El precio es obligatorio."),
  moneda: z.enum(["ARS", "USD"]).default("ARS"),
  // El vendedor puede fijar el estado ya en el alta (ej: cargar una privada).
  estado: estadoEnum.default("disponible")
});

// Alta rápida: queda visible en el sitio público de inmediato (sin aprobación).
propertyRoutes.post("/properties", async (req, res) => {
  const property = await props.createProperty(req.auth!, createSchema.parse(req.body));
  res.status(201).json({ property });
});

propertyRoutes.get("/properties/locations", async (req, res) => {
  res.json(await props.propertyLocations(req.auth!));
});

propertyRoutes.get("/properties/:id", async (req, res) => {
  res.json({ property: await props.getProperty(req.auth!, idParam().parse(req.params.id)) });
});

const updateSchema = z
  .object({
    titulo: z.string().trim().min(1).optional(),
    descripcion: z.string().nullable().optional(),
    operacion: z.enum(["venta", "alquiler", "ambos"]).optional(),
    tipo: tipoEnum.optional(),
    precio: z.coerce.number().nonnegative().optional(),
    moneda: z.enum(["ARS", "USD"]).optional(),
    estado: estadoEnum.optional(),
    // destacada NO va acá a propósito: se cambia solo por PATCH /:id/destacada
    // (admin-only, ver properties/service.ts). Así queda un único camino para
    // tocarla y no hay que blindar cada edición general contra pisarla sin
    // querer.
    direccion: z.string().nullable().optional(),
    zona: z.string().nullable().optional(),
    // Referencia libre ("a 1 cuadra de Mate de Luna"): NO es la zona ni la
    // dirección. Existe para que esos textos dejen de ir al campo zona.
    punto_referencia: z.string().trim().max(200).nullable().optional(),
    ciudad: z.string().nullable().optional(),
    ambientes: z.coerce.number().int().nonnegative().nullable().optional(),
    dormitorios: z.coerce.number().int().nonnegative().nullable().optional(),
    banios: z.coerce.number().int().nonnegative().nullable().optional(),
    sup_cubierta: z.coerce.number().nonnegative().nullable().optional(),
    sup_total: z.coerce.number().nonnegative().nullable().optional(),
    notas: z.string().nullable().optional(),
    requisitos: z.string().nullable().optional(),
    link_maps: z.string().url("Debe ser un link válido.").nullable().optional(),
    ...alquilerFields
  })
  .strict();

propertyRoutes.patch("/properties/:id", async (req, res) => {
  const id = idParam().parse(req.params.id);
  const {
    sup_cubierta,
    sup_total,
    link_maps,
    punto_referencia,
    plazo_contrato,
    plazo_otro,
    ajuste_otro,
    indice_ajuste,
    indice_fijo_pct,
    precio_alquiler,
    moneda_alquiler,
    ...rest
  } = updateSchema.parse(req.body);
  const property = await props.updateProperty(req.auth!, id, {
    ...rest,
    ...(punto_referencia !== undefined ? { puntoReferencia: punto_referencia } : {}),
    ...(sup_cubierta !== undefined ? { supCubierta: sup_cubierta } : {}),
    ...(sup_total !== undefined ? { supTotal: sup_total } : {}),
    ...(link_maps !== undefined ? { linkMaps: link_maps } : {}),
    ...(plazo_contrato !== undefined ? { plazoContrato: plazo_contrato } : {}),
    ...(plazo_otro !== undefined ? { plazoOtro: plazo_otro } : {}),
    ...(ajuste_otro !== undefined ? { ajusteOtro: ajuste_otro } : {}),
    ...(indice_ajuste !== undefined ? { indiceAjuste: indice_ajuste } : {}),
    ...(indice_fijo_pct !== undefined ? { indiceFijoPct: indice_fijo_pct } : {}),
    ...(precio_alquiler !== undefined ? { precioAlquiler: precio_alquiler } : {}),
    ...(moneda_alquiler !== undefined ? { monedaAlquiler: moneda_alquiler } : {})
  });
  res.json({ property });
});

propertyRoutes.delete("/properties/:id", async (req, res) => {
  await props.deleteProperty(req.auth!, idParam().parse(req.params.id));
  res.json({ ok: true });
});

propertyRoutes.patch("/properties/:id/estado", async (req, res) => {
  const id = idParam().parse(req.params.id);
  const { estado } = z.object({ estado: estadoEnum }).parse(req.body);
  res.json({ property: await props.setEstado(req.auth!, id, estado) });
});

// Toggle rápido de destacada (botón del detalle). Solo admin: el service ya
// lo valida, pero se corta acá antes de tocar la DB (misma UX que el resto de
// requireRole). El tope único del tenant se valida en el service.
propertyRoutes.patch("/properties/:id/destacada", requireRole("admin"), async (req, res) => {
  const id = idParam().parse(req.params.id);
  const { destacada } = z.object({ destacada: z.boolean() }).parse(req.body);
  res.json({ property: await props.setDestacada(req.auth!, id, destacada) });
});
