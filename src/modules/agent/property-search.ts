import { TIPOS, type Tipo } from "../../lib/property-opciones.js";

export function normalizeSearchText(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

// Confirmed inventory labels in San Miguel de Tucuman, not geographic inference.
export const NORTH_ZONE_ALIASES = ["barrio norte", "norte", "zon norte"];
export const NORTH_ZONE_CITY = "san miguel de tucuman";

export function zoneAlternatives(zone?: string, zones: string[] = []): string[] {
  const unique = new Map<string, string>();
  for (const input of [...zones, ...(zone ? [zone] : [])]) {
    for (const part of input.split(/,|\s+o\s+/i)) {
      const label = part.trim();
      const normalized = normalizeSearchText(label);
      if (normalized && !unique.has(normalized)) unique.set(normalized, label);
    }
  }
  return [...unique.values()];
}

const aliases: Record<string, string> = {
  depto: "departamento", dpto: "departamento", deptos: "departamento",
  departamentos: "departamento", casas: "casa", monoambientes: "monoambiente",
  dorm: "dormitorios", dormitorio: "dormitorios", habitaciones: "dormitorios",
  comprar: "venta", alquilar: "alquiler", locales: "local", terrenos: "terreno"
};
const stopWords = new Set(["de", "del", "la", "las", "el", "los", "un", "una", "en", "con", "y", "o", "para", "por", "busco", "quiero", "me", "interesa", "calle", "al", "numero"]);

export function searchTerms(value: string): string[] {
  return [...new Set(normalizeSearchText(value).split(" ").filter((word) => word && !stopWords.has(word))
    .map((word) => aliases[word] ?? word))].slice(0, 24);
}

export function resolvePropertyType(value?: string): Tipo | undefined {
  if (!value) return undefined;
  const normalized = normalizeSearchText(value);
  const key = ({ local: "local_comercial", "local comercial": "local_comercial", ph: "casa" } as Record<string, string>)[normalized]
    ?? aliases[normalized] ?? normalized.replaceAll(" ", "_");
  return TIPOS.find((type) => type === key);
}

export function identityTerms(reference: string): string[] {
  const text = normalizeSearchText(reference).replace(/\b\d+\s+(dormitorios?|habitaciones?|ambientes?|banos?)\b/g, " ");
  const generic = new Set(["departamento", "casa", "semipiso", "semi", "piso", "alquiler", "venta", "propiedad", "publicacion", "vi", "info"]);
  return searchTerms(text).filter((word) => !generic.has(word));
}
