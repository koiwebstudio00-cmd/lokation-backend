// Emisión de eventos de dominio (outbox). Se llama DENTRO de la transacción de
// negocio: emit_event() (SECURITY DEFINER) crea las deliveries para los
// endpoints suscriptos del tenant + globales. Ver webhooks.md.
import type { Tx } from "./prisma.js";

export type EventName =
  | "property.created"
  | "property.updated"
  | "property.estado_changed"
  | "property.deleted"
  | "lead.created"
  | "lead.updated"
  // Derivación del agente de IA a un vendedor (alta o reasignación por
  // timeout). Se encola para endpoints suscriptos; hoy falta agregarlo a
  // EVENTOS_VALIDOS para que pueda seleccionarse mediante la API.
  | "lead.assigned"
  | "user.invited"
  | "user.joined"
  | "tenant.created"
  | "tenant.suspended"
  | "ping";

export async function emitEvent(
  tx: Tx,
  evento: EventName,
  data: Record<string, unknown>
): Promise<void> {
  await tx.$executeRaw`select emit_event(${evento}, ${JSON.stringify(data)}::jsonb)`;
}

/** Payload público de una propiedad: sin notas ni datos internos. */
export function publicPropertyPayload(p: {
  id: string;
  tenantId: string;
  titulo: string;
  operacion: string;
  tipo: string;
  precio: unknown;
  moneda: string;
  precioAlquiler?: unknown;
  monedaAlquiler?: string | null;
  descripcion?: string | null;
  direccion?: string | null;
  zona?: string | null;
  ciudad?: string | null;
  estado: string;
  destacada?: boolean;
  linkMaps?: string | null;
  destino?: string | null;
  plazoContrato?: string | null;
  plazoOtro?: string | null;
  ajuste?: string | null;
  ajusteOtro?: string | null;
  indiceAjuste?: string | null;
  indiceFijoPct?: unknown;
  expensas?: string | null;
  mascotas?: string | null;
  amoblado?: string | null;
  lat?: unknown;
  lng?: unknown;
}): Record<string, unknown> {
  const numOrNull = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    id: p.id,
    tenant_id: p.tenantId,
    titulo: p.titulo,
    operacion: p.operacion,
    tipo: p.tipo,
    precio: String(p.precio),
    moneda: p.moneda,
    precio_alquiler: numOrNull(p.precioAlquiler),
    moneda_alquiler: p.monedaAlquiler ?? null,
    descripcion: p.descripcion ?? null,
    direccion: p.direccion ?? null,
    zona: p.zona ?? null,
    ciudad: p.ciudad ?? null,
    estado: p.estado,
    destacada: p.destacada ?? false,
    link_maps: p.linkMaps ?? null,
    // Datos de alquiler (públicos): nulos en propiedades de venta.
    destino: p.destino ?? null,
    plazo_contrato: p.plazoContrato ?? null,
    plazo_otro: p.plazoOtro ?? null,
    ajuste: p.ajuste ?? null,
    ajuste_otro: p.ajusteOtro ?? null,
    indice_ajuste: p.indiceAjuste ?? null,
    indice_fijo_pct: numOrNull(p.indiceFijoPct),
    expensas: p.expensas ?? null,
    mascotas: p.mascotas ?? null,
    amoblado: p.amoblado ?? null,
    lat: numOrNull(p.lat),
    lng: numOrNull(p.lng)
  };
}
