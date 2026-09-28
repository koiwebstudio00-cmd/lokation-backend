// Propiedades — sin fricción: el agente crea y la propiedad queda visible en
// el sitio público de inmediato (mismo flujo que el MVP de Lamelas).
import { Prisma } from "@prisma/client";
import { ApiError } from "../../lib/errors.js";
import { emitEvent, publicPropertyPayload } from "../../lib/events.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import { deleteObjects } from "../../lib/r2.js";
import { parseSearchQuery, palabrasWhere } from "../../lib/search.js";
import type {
  Tipo,
  Estado,
  Destino,
  Plazo,
  Ajuste,
  Indice,
  Mascotas,
  Amoblado
} from "../../lib/property-opciones.js";
import type { AccessClaims } from "../../lib/tokens.js";

const ctxOf = (a: AccessClaims) => ({
  userId: a.userId,
  tenantId: a.tenantId,
  rol: a.rol
});

export const PAGE_SIZE = 24;

export interface PropertyFilters {
  operacion?: "venta" | "alquiler";
  tipo?: Tipo;
  estado?: Estado;
  vendedor?: string;
  dormitorios?: number;
  q?: string;
  page: number;
  limit: number;
}

function whereFrom(f: PropertyFilters): Prisma.PropertyWhereInput {
  // Búsqueda natural: del texto libre `q` se extraen tipo y dormitorios; el
  // resto se busca por columnas. Los filtros explícitos (selects) mandan sobre
  // lo parseado.
  const parsed = f.q ? parseSearchQuery(f.q) : { palabras: [] as string[] };
  const tipo = f.tipo ?? parsed.tipo;
  const dormitorios = f.dormitorios ?? parsed.dormitorios;
  return {
    // "venta" trae venta+ambos; "alquiler" trae alquiler+ambos.
    ...(f.operacion ? { operacion: { in: [f.operacion, "ambos"] } } : {}),
    ...(tipo ? { tipo } : {}),
    ...(f.estado ? { estado: f.estado } : {}),
    ...(f.vendedor ? { userId: f.vendedor } : {}),
    // dormitorios: exacto para 1..3; 4 significa "4 o más".
    ...(dormitorios !== undefined
      ? { dormitorios: dormitorios >= 4 ? { gte: dormitorios } : dormitorios }
      : {}),
    ...palabrasWhere(parsed.palabras)
  };
}

const LIST_INCLUDE = {
  images: {
    where: { esPortada: true },
    select: { id: true, url: true },
    take: 1
  },
  user: { select: { id: true, nombre: true } }
} satisfies Prisma.PropertyInclude;

export async function listProperties(auth: AccessClaims, f: PropertyFilters) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const where = whereFrom(f);
    const [data, total] = await Promise.all([
      tx.property.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: { createdAt: "desc" },
        skip: (f.page - 1) * f.limit,
        take: f.limit
      }),
      tx.property.count({ where })
    ]);
    return { data, meta: { page: f.page, limit: f.limit, total } };
  });
}

export async function myProperties(auth: AccessClaims, f: PropertyFilters) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const where = { ...whereFrom(f), userId: auth.userId };
    const [data, total, porEstado] = await Promise.all([
      tx.property.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: { createdAt: "desc" },
        skip: (f.page - 1) * f.limit,
        take: f.limit
      }),
      tx.property.count({ where }),
      tx.property.groupBy({
        by: ["estado"],
        where: { userId: auth.userId },
        _count: { _all: true }
      })
    ]);
    const contadores = Object.fromEntries(
      porEstado.map((e: { estado: string; _count: { _all: number } }) => [
        e.estado,
        e._count._all
      ])
    );
    return { data, meta: { page: f.page, limit: f.limit, total }, contadores };
  });
}

export async function createProperty(
  auth: AccessClaims,
  data: {
    titulo: string;
    operacion: "venta" | "alquiler" | "ambos";
    tipo: Tipo;
    precio: number;
    moneda?: "ARS" | "USD";
    estado?: Estado;
  }
) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const property = await tx.property.create({
      data: {
        ...data,
        tenantId: auth.tenantId!,
        userId: auth.userId
      }
    });
    await emitEvent(tx, "property.created", publicPropertyPayload(property));
    return property;
  });
}

export async function getProperty(auth: AccessClaims, id: string) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const property = await tx.property.findUnique({
      where: { id },
      include: {
        images: { orderBy: [{ esPortada: "desc" }, { orden: "asc" }] },
        user: { select: { id: true, nombre: true } }
      }
    });
    if (!property) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    return property;
  });
}

export interface PropertyUpdate {
  titulo?: string;
  descripcion?: string | null;
  operacion?: "venta" | "alquiler" | "ambos";
  tipo?: Tipo;
  precio?: number;
  moneda?: "ARS" | "USD";
  precioAlquiler?: number | null;
  monedaAlquiler?: "ARS" | "USD" | null;
  estado?: Estado;
  // destacada NO está acá: se cambia solo vía setDestacada (PATCH
  // /:id/destacada, admin-only). updateProperty nunca la toca.
  direccion?: string | null;
  zona?: string | null;
  ciudad?: string | null;
  ambientes?: number | null;
  dormitorios?: number | null;
  banios?: number | null;
  supCubierta?: number | null;
  supTotal?: number | null;
  notas?: string | null;
  requisitos?: string | null;
  linkMaps?: string | null;
  // Campos de alquiler (todos nullable).
  destino?: Destino | null;
  plazoContrato?: Plazo | null;
  plazoOtro?: string | null;
  ajuste?: Ajuste | null;
  ajusteOtro?: string | null;
  indiceAjuste?: Indice | null;
  indiceFijoPct?: number | null;
  expensas?: string | null;
  mascotas?: Mascotas | null;
  amoblado?: Amoblado | null;
  lat?: number | null;
  lng?: number | null;
}

// Destacar es SOLO admin, y el tope es único para todo el tenant (no por
// vendedor) — la idea es que el admin cure a mano una vitrina chica según qué
// propiedades reciben consultas, no que cada vendedor arme la suya. Ver
// prop_update en migration.sql: la RLS deja pasar la fila a cualquier dueño,
// el corte de admin es responsabilidad de esta capa.
export const MAX_DESTACADAS_POR_TENANT = 12;

function assertPuedeDestacar(auth: AccessClaims) {
  if (auth.rol !== "admin") {
    throw new ApiError("FORBIDDEN", "Solo un admin puede destacar propiedades.");
  }
}

// Valida el tope antes de destacar. `exceptoId` no se cuenta (por si la que se
// está guardando ya estaba destacada). RLS ya scopea el count al tenant actual.
async function assertTopeDestacadas(tx: Tx, exceptoId: string) {
  const enUso = await tx.property.count({
    where: { destacada: true, id: { not: exceptoId } }
  });
  if (enUso >= MAX_DESTACADAS_POR_TENANT) {
    throw new ApiError(
      "LIMIT_EXCEEDED",
      `Llegaste al máximo de ${MAX_DESTACADAS_POR_TENANT} propiedades destacadas. Quitá el destacado de otra para destacar esta.`
    );
  }
}

export async function updateProperty(auth: AccessClaims, id: string, data: PropertyUpdate) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const { count } = await tx.property.updateMany({ where: { id }, data });
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    const property = (await tx.property.findUnique({ where: { id } }))!;
    await emitEvent(tx, "property.updated", {
      ...publicPropertyPayload(property),
      changed_fields: Object.keys(data)
    });
    return property;
  });
}

export async function deleteProperty(auth: AccessClaims, id: string) {
  const keys = await runWithContext(ctxOf(auth), async (tx) => {
    const images = await tx.propertyImage.findMany({
      where: { propertyId: id },
      select: { r2Key: true }
    });
    const { count } = await tx.property.deleteMany({ where: { id } });
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    await emitEvent(tx, "property.deleted", { property_id: id });
    return images.map((i: { r2Key: string }) => i.r2Key);
  });
  // Fuera de la transacción: si R2 falla, la BD ya quedó consistente.
  await deleteObjects(keys);
}

export async function setEstado(auth: AccessClaims, id: string, estado: Estado) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const before = await tx.property.findUnique({ where: { id } });
    if (!before) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    const { count } = await tx.property.updateMany({ where: { id }, data: { estado } });
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    await emitEvent(tx, "property.estado_changed", {
      property_id: id,
      estado_anterior: before.estado,
      estado
    });
    return tx.property.findUnique({ where: { id } });
  });
}

export async function setDestacada(auth: AccessClaims, id: string, destacada: boolean) {
  assertPuedeDestacar(auth);
  return runWithContext(ctxOf(auth), async (tx) => {
    const before = await tx.property.findUnique({
      where: { id },
      select: { destacada: true }
    });
    if (!before) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    // Solo se valida el tope al prender (apagar siempre se puede).
    if (destacada && !before.destacada) await assertTopeDestacadas(tx, id);
    const { count } = await tx.property.updateMany({ where: { id }, data: { destacada } });
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    const property = (await tx.property.findUnique({ where: { id } }))!;
    await emitEvent(tx, "property.updated", {
      ...publicPropertyPayload(property),
      changed_fields: ["destacada"]
    });
    return property;
  });
}
