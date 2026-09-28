// Búsqueda en lenguaje natural para el catálogo de propiedades.
//
// Enfoque heurístico, sin IA ni costo (decisión del paquete de upgrades, #8):
// del texto libre que escribe la persona ("un depto de 2 dormitorios en barrio
// sur") se extraen de forma determinista el `tipo` (por sinónimos, tolerando
// acentos y abreviaturas) y la cantidad de `dormitorios` (por regex). El resto
// de las palabras se busca por texto en varias columnas con ILIKE, acelerado
// por los índices GIN `pg_trgm` de la migración 20260817010000.
//
// Puerta abierta: ranking por `similarity()` + `unaccent` (acento-insensible) o
// IA, si el catálogo crece y hace falta más tolerancia a tipeos.
import { Prisma } from "@prisma/client";
import type { Tipo } from "./property-opciones.js";

// Sinónimos → valor canónico de `tipo`. Se comparan ya normalizados (minúsculas
// y sin acentos), así que "dúplex" y "duplex" caen en la misma clave. Se limita
// a mapeos inequívocos para no clasificar mal.
const TIPO_SINONIMOS: Record<string, Tipo> = {
  monoambiente: "monoambiente",
  mono: "monoambiente",
  departamento: "departamento",
  depto: "departamento",
  depa: "departamento",
  dpto: "departamento",
  casa: "casa",
  duplex: "duplex",
  "local comercial": "local_comercial",
  local: "local_comercial",
  oficina: "oficina",
  galpon: "galpon",
  cochera: "estacionamiento",
  garage: "estacionamiento",
  garaje: "estacionamiento",
  estacionamiento: "estacionamiento",
  terreno: "terreno",
  lote: "terreno"
};

// Sinónimos de más de una palabra: se buscan primero, como frase.
const TIPO_SINONIMOS_FRASE = Object.keys(TIPO_SINONIMOS).filter((s) => s.includes(" "));

// Palabras de relleno que no aportan a la búsqueda por texto.
const STOPWORDS = new Set([
  "en", "de", "con", "un", "una", "unos", "unas", "para", "cerca", "el", "la",
  "los", "las", "y", "o", "al", "del", "que", "busco", "quiero", "necesito",
  "zona", "barrio", "b"
]);

/** Minúsculas, sin acentos y con espacios colapsados. */
export function normaliza(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ParsedQuery {
  tipo?: Tipo;
  dormitorios?: number;
  /** Palabras sueltas para buscar por columnas (todas deben aparecer). */
  palabras: string[];
}

export function parseSearchQuery(q: string): ParsedQuery {
  const norm = normaliza(q);
  if (!norm) return { palabras: [] };

  let tipo: Tipo | undefined;
  let resto = norm;

  // 1) tipo por frase ("local comercial") y luego por palabra.
  for (const frase of TIPO_SINONIMOS_FRASE) {
    if (resto.includes(frase)) {
      tipo = TIPO_SINONIMOS[frase];
      resto = resto.replace(frase, " ");
      break;
    }
  }
  if (!tipo) {
    for (const token of resto.split(" ")) {
      const canon = TIPO_SINONIMOS[token];
      if (canon) {
        tipo = canon;
        resto = resto.replace(new RegExp(`\\b${token}\\b`), " ");
        break;
      }
    }
  }

  // 2) dormitorios: "2 dormitorios", "3 dorm", "1 habitacion".
  let dormitorios: number | undefined;
  const dorm = resto.match(/(\d+)\s*(dormitorios?|dorm\.?|habitacion(?:es)?|hab\.?)/);
  const dormRaw = dorm?.[1];
  if (dormRaw) {
    const n = parseInt(dormRaw, 10);
    if (n >= 0 && n <= 20) dormitorios = n;
    resto = resto.replace(dorm?.[0] ?? "", " ");
  }

  // 3) resto: palabras significativas (sin stopwords ni números sueltos).
  const palabras = resto
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

  return { tipo, dormitorios, palabras };
}

// Columnas de texto donde se busca cada palabra. `descripcion` es pública (la
// muestra la ficha), así que no hay fuga: no se incluye `notas` ni datos internos.
const COLUMNAS_TEXTO = ["titulo", "descripcion", "zona", "ciudad", "direccion"] as const;

/**
 * `where` de texto: cada palabra tiene que aparecer en alguna de las columnas
 * (AND de palabras, OR de columnas). Devuelve `{}` si no hay palabras.
 */
export function palabrasWhere(palabras: string[]): Prisma.PropertyWhereInput {
  if (palabras.length === 0) return {};
  return {
    AND: palabras.map((palabra) => ({
      OR: COLUMNAS_TEXTO.map((col) => ({
        [col]: { contains: palabra, mode: "insensitive" as const }
      }))
    }))
  };
}
