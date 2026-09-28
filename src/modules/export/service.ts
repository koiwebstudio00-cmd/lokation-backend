// Export — datos públicos del tenant para sitios y plataformas de clientes.
// Regla 9 de CLAUDE.md: los selects de este módulo JAMÁS incluyen notas,
// user_id ni tenant_id. Cada endpoint tiene su test anti-fuga.
//
// La gestión de API keys se mudó a modules/integrations en 0011: este módulo
// ya no sabe nada de credenciales, solo sirve datos con el tenant que le pasa
// el middleware.
import { Prisma } from "@prisma/client";
import { ApiError } from "../../lib/errors.js";
import { runWithContext } from "../../lib/prisma.js";
import { parseSearchQuery, palabrasWhere } from "../../lib/search.js";
import type { Tipo, Estado } from "../../lib/property-opciones.js";

const EXPORT_PROPERTY_SELECT = {
  id: true,
  slug: true,
  titulo: true,
  operacion: true,
  tipo: true,
  precio: true,
  moneda: true,
  precioAlquiler: true,
  monedaAlquiler: true,
  descripcion: true,
  direccion: true,
  zona: true,
  ciudad: true,
  ambientes: true,
  dormitorios: true,
  banios: true,
  supCubierta: true,
  supTotal: true,
  estado: true,
  destacada: true,
  linkMaps: true,
  // Datos de alquiler (públicos): la web puede mostrarlos en la ficha.
  destino: true,
  plazoContrato: true,
  plazoOtro: true,
  ajuste: true,
  ajusteOtro: true,
  indiceAjuste: true,
  indiceFijoPct: true,
  expensas: true,
  mascotas: true,
  amoblado: true,
  lat: true,
  lng: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.PropertySelect;

const IMAGE_SELECT = {
  id: true,
  url: true,
  esPortada: true,
  orden: true
} satisfies Prisma.PropertyImageSelect;

export type ExportSort = "recent" | "price-asc" | "price-desc";

export interface ExportFilters {
  operacion?: "venta" | "alquiler";
  tipo?: Tipo;
  estado?: Estado;
  zona?: string;
  ciudad?: string;
  precioMin?: number;
  precioMax?: number;
  ambientes?: number;
  /** Mínimo (legacy `dormitorios_min`). */
  dormitoriosMin?: number;
  /** Exacto para 1..3; 4 = "4 o más" (buscador de la web). */
  dormitorios?: number;
  /** Texto libre del buscador de la web (parseo heurístico + texto). */
  q?: string;
  updatedSince?: Date;
  sort?: ExportSort;
  page: number;
  limit: number;
}

function whereFrom(f: ExportFilters): Prisma.PropertyWhereInput {
  // Buscador natural de la web: mismo parser que el panel. Los filtros
  // explícitos (selects) mandan sobre lo que se deduce del texto.
  const parsed = f.q ? parseSearchQuery(f.q) : { palabras: [] as string[] };
  const tipo = f.tipo ?? parsed.tipo;
  const dormitorios = f.dormitorios ?? parsed.dormitorios;
  return {
    // "venta" trae venta+ambos; "alquiler" trae alquiler+ambos.
    ...(f.operacion ? { operacion: { in: [f.operacion, "ambos"] } } : {}),
    ...(tipo ? { tipo } : {}),
    // Sin filtro devuelve todo: cada sitio decide si muestra reservadas/vendidas.
    ...(f.estado ? { estado: f.estado } : {}),
    ...(f.zona ? { zona: { contains: f.zona, mode: "insensitive" as const } } : {}),
    ...(f.ciudad ? { ciudad: { contains: f.ciudad, mode: "insensitive" as const } } : {}),
    ...(f.precioMin !== undefined || f.precioMax !== undefined
      ? {
          precio: {
            ...(f.precioMin !== undefined ? { gte: f.precioMin } : {}),
            ...(f.precioMax !== undefined ? { lte: f.precioMax } : {})
          }
        }
      : {}),
    // ambientes = mínimo ("3" ⇒ 3 o más), criterio inmobiliario
    ...(f.ambientes !== undefined ? { ambientes: { gte: f.ambientes } } : {}),
    // dormitorios: exacto (1..3) o "4 o más". `dormitoriosMin` (legacy) = mínimo.
    ...(dormitorios !== undefined
      ? { dormitorios: dormitorios >= 4 ? { gte: dormitorios } : dormitorios }
      : f.dormitoriosMin !== undefined
        ? { dormitorios: { gte: f.dormitoriosMin } }
        : {}),
    // texto libre del buscador (cada palabra en alguna columna)
    ...palabrasWhere(parsed.palabras),
    // sync incremental para réplicas de clientes
    ...(f.updatedSince ? { updatedAt: { gt: f.updatedSince } } : {})
  };
}

// El id como criterio secundario mantiene el orden estable entre páginas:
// sin él, dos filas con el mismo precio pueden repetirse o saltearse al paginar.
function orderFrom(sort: ExportSort | undefined): Prisma.PropertyOrderByWithRelationInput[] {
  switch (sort) {
    case "price-asc":
      return [{ precio: "asc" }, { id: "asc" }];
    case "price-desc":
      return [{ precio: "desc" }, { id: "asc" }];
    default:
      // Orden por defecto de la web: las destacadas primero, después lo más nuevo.
      // (En los ordenamientos por precio manda el precio, no el destacado.)
      return [{ destacada: "desc" }, { createdAt: "desc" }, { id: "asc" }];
  }
}

export async function listExportProperties(tenantId: string, f: ExportFilters) {
  const where = whereFrom(f);
  return runWithContext({ tenantId, rol: "public" }, async (tx) => {
    const [data, total] = await Promise.all([
      tx.property.findMany({
        where,
        select: {
          ...EXPORT_PROPERTY_SELECT,
          images: { where: { esPortada: true }, select: IMAGE_SELECT, take: 1 }
        },
        orderBy: orderFrom(f.sort),
        skip: (f.page - 1) * f.limit,
        take: f.limit
      }),
      tx.property.count({ where })
    ]);
    return { data, meta: { page: f.page, limit: f.limit, total } };
  });
}

// Ciudades con inventario, para poblar el filtro del sitio sin traer todo el
// listado. `distinct` lo resuelve la BD; el orden alfabético es local (es-AR).
export async function listExportCiudades(
  tenantId: string,
  estado?: ExportFilters["estado"]
): Promise<string[]> {
  const rows = await runWithContext({ tenantId, rol: "public" }, (tx) =>
    tx.property.findMany({
      where: { ciudad: { not: null }, ...(estado ? { estado } : {}) },
      select: { ciudad: true },
      distinct: ["ciudad"]
    })
  );
  const ciudades = rows
    .map((r) => r.ciudad?.trim())
    .filter((c): c is string => Boolean(c));
  return [...new Set(ciudades)].sort((a, b) => a.localeCompare(b, "es"));
}

// Zonas con inventario, espejo de listExportCiudades: puebla el filtro de zona
// del sitio (Yerba Buena, Microcentro, Barrio Sur, etc.) sin traer el listado.
export async function listExportZonas(
  tenantId: string,
  estado?: ExportFilters["estado"]
): Promise<string[]> {
  const rows = await runWithContext({ tenantId, rol: "public" }, (tx) =>
    tx.property.findMany({
      where: { zona: { not: null }, ...(estado ? { estado } : {}) },
      select: { zona: true },
      distinct: ["zona"]
    })
  );
  const zonas = rows
    .map((r) => r.zona?.trim())
    .filter((z): z is string => Boolean(z));
  return [...new Set(zonas)].sort((a, b) => a.localeCompare(b, "es"));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getExportProperty(tenantId: string, idOrSlug: string) {
  // La web pública referencia por slug; también se acepta el uuid.
  const where: Prisma.PropertyWhereUniqueInput = UUID_RE.test(idOrSlug)
    ? { id: idOrSlug }
    : { slug: idOrSlug };
  const property = await runWithContext({ tenantId, rol: "public" }, (tx) =>
    tx.property.findUnique({
      where,
      select: {
        ...EXPORT_PROPERTY_SELECT,
        images: {
          select: IMAGE_SELECT,
          orderBy: [{ esPortada: "desc" as const }, { orden: "asc" as const }]
        }
      }
    })
  );
  if (!property) throw new ApiError("NOT_FOUND", "El recurso no existe.");
  return property;
}

export async function getExportSite(tenantId: string) {
  // Contexto 'export' (no 'public'): la policy de 0003 le cierra tenants a
  // public a propósito; tenants_export_select (0007) cubre esta lectura.
  const site = await runWithContext({ tenantId, rol: "export" }, (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { nombre: true, slug: true, logoUrl: true, configSitio: true }
    })
  );
  if (!site) throw new ApiError("NOT_FOUND", "El recurso no existe.");
  return site;
}
