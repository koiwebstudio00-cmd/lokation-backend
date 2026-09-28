// Valores canónicos de las listas de propiedad. La BD guarda estos strings
// (columnas `text`); las etiquetas "lindas" viven en la UI del panel. El agente
// y el export comparan contra estos canónicos, nunca contra la etiqueta.
//
// Regla: agregar una opción nueva = sumarla acá (y su label en el panel). No hay
// enums de Postgres que migrar.

export const TIPOS = [
  "monoambiente",
  "departamento",
  "casa",
  "duplex",
  "local_comercial",
  "oficina",
  "galpon",
  "estacionamiento",
  "terreno",
  "otro"
] as const;

// Todos los estados están disponibles para cualquier operación (venta o
// alquiler): el vendedor elige el que corresponda.
export const ESTADOS = [
  "disponible",
  "reservado",
  "proximamente",
  "pausado",
  "vendida",
  "alquilada",
  // Privado: no se publica en la web, pero el agente de IA sí la puede ofrecer.
  "privado"
] as const;

export const DESTINOS = ["vivienda", "comercial", "profesional", "otro"] as const;

// Valores sin dígito inicial: así el label del enum de Postgres coincide con el
// nombre del miembro en Prisma Client (que no admite identificadores que
// empiecen con número). La UI muestra "12 meses", etc.
export const PLAZOS = ["meses_12", "meses_18", "meses_24", "meses_36", "otro"] as const;

export const AJUSTES = ["trimestral", "cuatrimestral", "otro"] as const;

export const INDICES = ["icl", "ipc", "fijo"] as const;

export const MASCOTAS = ["se_permiten", "no_se_permiten", "sin_especificar"] as const;

export const AMOBLADO = ["amoblado", "sin_amoblar", "sin_especificar"] as const;

export type Tipo = (typeof TIPOS)[number];
export type Estado = (typeof ESTADOS)[number];
export type Destino = (typeof DESTINOS)[number];
export type Plazo = (typeof PLAZOS)[number];
export type Ajuste = (typeof AJUSTES)[number];
export type Indice = (typeof INDICES)[number];
export type Mascotas = (typeof MASCOTAS)[number];
export type Amoblado = (typeof AMOBLADO)[number];
