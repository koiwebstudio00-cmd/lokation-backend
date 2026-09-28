// Resumen estructurado del agente: schema, render y extracción del perfil.
//
// El mismo objeto cumple tres funciones (ver arquitectura-agente.md §6):
//   1. memoria comprimida del propio agente,
//   2. brief que recibe el vendedor al derivar,
//   3. perfil consultable del lead para el panel y las métricas.
//
// El bloque `perfil` viene explícito en el structured output, no se parsea de
// la prosa: sacar "hasta usd 90.000" de un texto libre es exactamente el tipo
// de heurística que se rompe en producción. Al modelo se le pide que llene las
// dos cosas en la misma llamada.
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { TIPOS } from "../../lib/property-opciones.js";

// El tipo que busca el lead usa el mismo set canónico que las propiedades.
export const TIPOS_PROPIEDAD = TIPOS;

// El resumen lo produce un LLM, no un cliente confiable: llega con `null` en lo
// desconocido (structured output), arrays mandados como valor suelto, `moneda`
// en minúscula y números como string. En vez de un 400 que aborta el handoff
// completo por un campo cosmético del brief, se tolera y se limpia acá.

/** Quita null, "" y vacíos recursivamente: deja solo lo que el vendedor va a leer. */
const limpiar = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    const a = v.map(limpiar).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (v && typeof v === "object") {
    const o = Object.fromEntries(
      Object.entries(v)
        .map(([k, x]) => [k, limpiar(x)])
        .filter(([, x]) => x !== undefined)
    );
    return Object.keys(o).length ? o : undefined;
  }
  return v === null || v === "" ? undefined : v;
};

/** Acepta un valor suelto o un array y siempre devuelve array (el modelo manda las dos formas). */
const flexArray = (inner: z.ZodTypeAny, max: number) =>
  z.preprocess((v) => (v == null ? v : Array.isArray(v) ? v : [v]), z.array(inner).max(max));

/** Enum tolerante: normaliza mayúsculas/minúsculas y, si no matchea, descarta en vez de romper. */
const enumSuave = <const T extends readonly [string, ...string[]]>(vals: T, caso: "lower" | "upper") =>
  z
    .preprocess(
      (v) => (typeof v === "string" ? (caso === "lower" ? v.trim().toLowerCase() : v.trim().toUpperCase()) : v),
      z.enum(vals)
    )
    .catch(undefined as unknown as T[number]);

export const perfilSchema = z.object({
  tipo_propiedad: flexArray(z.enum(TIPOS_PROPIEDAD).catch("otro"), 5).optional(),
  ciudad: z.string().trim().max(120).optional(),
  zonas: flexArray(z.string().trim().max(120), 10).optional(),
  presupuesto_min: z.coerce.number().nonnegative().optional(),
  presupuesto_max: z.coerce.number().nonnegative().optional(),
  moneda: enumSuave(["ARS", "USD"], "upper").optional(),
  dormitorios_min: z.coerce.number().int().min(0).max(20).optional(),
  property_id: z.string().uuid().catch(undefined as unknown as string).optional()
});

export const resumenSchema = z.preprocess(
  limpiar,
  z.object({
    nombre: z.string().trim().max(200).optional(),
    /// Lo que quiere el lead. Ojo: no es la `operacion` de la propiedad.
    operacion: enumSuave(["comprar", "alquilar", "vender", "tasar", "consulta"], "lower").optional(),
    propiedades_interes: flexArray(z.coerce.string().max(300), 10).optional(),
    presupuesto: z.coerce.string().max(200).optional(),
    forma_de_pago: z.coerce.string().max(300).optional(),
    urgencia: z.coerce.string().max(300).optional(),
    /// El oro del vendedor: todo lo que el lead dejó caer al pasar.
    detalles_importantes: flexArray(z.coerce.string().max(300), 20).optional(),
    estado_conversacion: z.coerce.string().max(300).optional(),
    proximo_paso_sugerido: z.coerce.string().max(300).optional(),
    temperatura: enumSuave(["fria", "tibia", "caliente"], "lower").optional(),
    /// Clasificación comercial del lead: `potencial` (cliente real) vs
    /// `fantasma` (curioso). Se guarda en el lead para las métricas.
    clasificacion: enumSuave(["potencial", "fantasma"], "lower").optional(),
    perfil: perfilSchema.optional()
  })
);

export type Resumen = z.infer<typeof resumenSchema>;

/**
 * Traduce el resumen a las columnas de `conversations`. Solo devuelve las
 * claves presentes: un resumen posterior más pobre no tiene que borrar lo que
 * ya se sabía del lead.
 */
export function perfilAColumnas(r: Resumen): Prisma.ConversationUpdateInput {
  const p = r.perfil ?? {};
  const data: Prisma.ConversationUpdateInput = {};

  if (r.operacion) data.intencion = r.operacion;
  if (r.temperatura) data.temperatura = r.temperatura;
  if (p.tipo_propiedad?.length) data.tipoPropiedad = p.tipo_propiedad;
  if (p.ciudad) data.ciudad = p.ciudad;
  if (p.zonas?.length) data.zonas = p.zonas;
  if (p.presupuesto_min !== undefined) data.presupuestoMin = p.presupuesto_min;
  if (p.presupuesto_max !== undefined) data.presupuestoMax = p.presupuesto_max;
  if (p.moneda) data.moneda = p.moneda;
  if (p.dormitorios_min !== undefined) data.dormitoriosMin = p.dormitorios_min;
  if (p.property_id) data.property = { connect: { id: p.property_id } };

  return data;
}

const INTENCION_TEXTO: Record<string, string> = {
  comprar: "comprar",
  alquilar: "alquilar",
  vender: "vender",
  tasar: "tasar una propiedad",
  consulta: "consultar"
};

function fechaCorta(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${mi}`;
}

/**
 * Render legible del resumen. Vive acá y no en n8n ni en el panel: así el
 * email al vendedor, la nota del lead y la vista de chat muestran lo mismo.
 */
export function renderResumen(r: Resumen, ahora: Date = new Date()): string {
  const lineas: string[] = [`🤖 Resumen del agente — ${fechaCorta(ahora)}`, ""];

  const busca = [
    r.operacion ? INTENCION_TEXTO[r.operacion] : null,
    r.presupuesto,
    r.forma_de_pago
  ].filter(Boolean);
  if (busca.length) lineas.push(`Busca: ${busca.join(" · ")}`);

  if (r.urgencia) lineas.push(`Urgencia: ${r.urgencia}`);
  if (r.propiedades_interes?.length) {
    lineas.push(`Le interesan: ${r.propiedades_interes.join(" · ")}`);
  }

  const zona = [r.perfil?.zonas?.join(", "), r.perfil?.ciudad].filter(Boolean).join(", ");
  if (zona) lineas.push(`Zona: ${zona}`);

  if (r.detalles_importantes?.length) {
    lineas.push("", "Detalles importantes:");
    for (const d of r.detalles_importantes) lineas.push(`• ${d}`);
  }

  lineas.push("");
  if (r.estado_conversacion) lineas.push(`Dónde quedó: ${r.estado_conversacion}`);
  if (r.proximo_paso_sugerido) lineas.push(`Próximo paso: ${r.proximo_paso_sugerido}`);
  if (r.temperatura) lineas.push(`Temperatura: ${r.temperatura}`);
  if (r.clasificacion) lineas.push(`Clasificación: ${r.clasificacion}`);

  // Sin líneas en blanco de más si el resumen vino flaco.
  return lineas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
