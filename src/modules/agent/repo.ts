import { Prisma } from "@prisma/client";
import type { Tx } from "../../lib/prisma.js";
import type { Estado, Mascotas, Amoblado } from "../../lib/property-opciones.js";
import * as assignment from "../crm/assignment.repo.js";
import { normalizeSearchText, resolvePropertyType, searchTerms, zoneAlternatives, NORTH_ZONE_ALIASES, NORTH_ZONE_CITY } from "./property-search.js";

// ── Propiedades (tool buscar_propiedades) ────────────────────────────────────
// Regla del canal: el agente solo maneja información pública. Este select es
// el de export más el slug para armar el link — sin `notas` y sin `user_id`.
// Tiene test anti-fuga, igual que los endpoints de export (regla 9).
export const AGENT_PROPERTY_SELECT = {
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
  requisitos: true,
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
  // Datos de alquiler (públicos): Sofi los usa para responder plazo, ajuste,
  // expensas, mascotas y amoblado cuando el lead pregunta.
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
  lng: true
} satisfies Prisma.PropertySelect;

export interface AgentPropertyFilters {
  q?: string;
  operacion?: "venta" | "alquiler";
  tipo?: string;
  estado?: Estado;
  zona?: string;
  ciudad?: string;
  zonas?: string[];
  moneda?: "ARS" | "USD";
  mascotas?: Mascotas;
  amoblado?: Amoblado;
  excluirIds?: string[];
  excluirSlugs?: string[];
  precioMin?: number;
  precioMax?: number;
  ambientes?: number;
  dormitorios?: number;
  dormitoriosMax?: number;
  ambientesExactos?: number;
  sort?: "recent" | "price-asc" | "price-desc";
  page: number;
  limit: number;
}

function normalizedSql(expression: Prisma.Sql) {
  return Prisma.sql`trim(regexp_replace(translate(lower(coalesce(${expression}, '')), ${"\u00e1\u00e9\u00ed\u00f3\u00fa\u00fc\u00f1"}, 'aeiouun'), '[^a-z0-9]+', ' ', 'g'))`;
}

const TENANT_FILTER = Prisma.sql`p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
const IDENTITY_TEXT = normalizedSql(Prisma.sql`concat_ws(' ', p.direccion, p.titulo)`);
const SEARCH_TEXT = normalizedSql(Prisma.sql`concat_ws(' ', p.titulo, p.descripcion, p.direccion, p.zona, p.ciudad, p.tipo,
  case when p.operacion::text = 'ambos' then 'venta alquiler' else p.operacion::text end)`);

function termMatch(expression: Prisma.Sql, term: string) {
  // Numeric boundaries prevent address 660 from matching 6600.
  return /^\d+$/.test(term)
    ? Prisma.sql`(' ' || ${expression} || ' ') like ${`% ${term} %`}`
    : Prisma.sql`${expression} like ${`%${term}%`}`;
}

function zoneMatch(zone: string) {
  const normalized = normalizeSearchText(zone);
  const storedZone = normalizedSql(Prisma.sql`p.zona`);
  const literalMatch = Prisma.sql`${storedZone} like ${`%${normalized}%`}`;
  if (!NORTH_ZONE_ALIASES.includes(normalized)) return literalMatch;
  return Prisma.sql`case when ${normalizedSql(Prisma.sql`p.ciudad`)} = ${NORTH_ZONE_CITY}
    then ${storedZone} in (${Prisma.join(NORTH_ZONE_ALIASES)})
    else ${literalMatch} end`;
}

async function publicRows(tx: Tx, ids: string[]) {
  const rows = await tx.property.findMany({
    where: { id: { in: ids } },
    select: { ...AGENT_PROPERTY_SELECT, images: { where: { esPortada: true }, select: { url: true }, take: 1 } }
  });
  return ids.flatMap((id) => rows.filter((row) => row.id === id));
}

export async function searchProperties(tx: Tx, f: AgentPropertyFilters) {
  const price = f.operacion === "alquiler"
    ? Prisma.sql`case when p.operacion::text = 'ambos' then p.precio_alquiler else p.precio end`
    : Prisma.sql`p.precio`;
  const currency = f.operacion === "alquiler"
    ? Prisma.sql`case when p.operacion::text = 'ambos' then p.moneda_alquiler else p.moneda end`
    : Prisma.sql`p.moneda`;
  const clauses = [TENANT_FILTER, Prisma.sql`p.estado::text in (${Prisma.join(f.estado ? [f.estado] : ["disponible", "privado"])})`];
  if (f.operacion) clauses.push(Prisma.sql`p.operacion::text in (${f.operacion}, 'ambos')`);
  const type = resolvePropertyType(f.tipo);
  if (type) clauses.push(Prisma.sql`p.tipo::text = ${type}`);
  if (f.ciudad) clauses.push(Prisma.sql`${normalizedSql(Prisma.sql`p.ciudad`)} like ${`%${normalizeSearchText(f.ciudad)}%`}`);
  const zones = zoneAlternatives(f.zona, f.zonas);
  if (zones.length) clauses.push(Prisma.sql`(${Prisma.join(zones.map(zoneMatch), " OR ")})`);
  if (f.moneda) clauses.push(Prisma.sql`${currency}::text = ${f.moneda}`);
  if (f.precioMin !== undefined) clauses.push(Prisma.sql`${price} >= ${f.precioMin}`);
  if (f.precioMax !== undefined) clauses.push(Prisma.sql`${price} <= ${f.precioMax}`);
  if (f.dormitorios !== undefined) clauses.push(Prisma.sql`p.dormitorios >= ${f.dormitorios}`);
  if (f.dormitoriosMax !== undefined) clauses.push(Prisma.sql`p.dormitorios <= ${f.dormitoriosMax}`);
  if (f.ambientes !== undefined) clauses.push(Prisma.sql`p.ambientes >= ${f.ambientes}`);
  if (f.ambientesExactos !== undefined) clauses.push(Prisma.sql`p.ambientes = ${f.ambientesExactos}`);
  if (f.mascotas) clauses.push(Prisma.sql`p.mascotas::text = ${f.mascotas}`);
  if (f.amoblado) clauses.push(Prisma.sql`p.amoblado::text = ${f.amoblado}`);
  if (f.excluirIds?.length) clauses.push(Prisma.sql`p.id::text not in (${Prisma.join(f.excluirIds)})`);
  if (f.excluirSlugs?.length) clauses.push(Prisma.sql`(p.slug is null or p.slug not in (${Prisma.join(f.excluirSlugs)}))`);
  for (const term of searchTerms(f.q ?? "")) clauses.push(termMatch(SEARCH_TEXT, term));
  const where = Prisma.join(clauses, " AND ");
  // Without a currency filter, group by currency rather than comparing ARS with USD.
  const order = f.sort === "price-asc" ? Prisma.sql`${currency} asc, ${price} asc nulls last, p.id asc`
    : f.sort === "price-desc" ? Prisma.sql`${currency} asc, ${price} desc nulls last, p.id asc`
    : Prisma.sql`p.destacada desc, p.created_at desc, p.id asc`;
  const [count] = await tx.$queryRaw<{ total: bigint }[]>`select count(*) as total from properties p where ${where}`;
  const ids = await tx.$queryRaw<{ id: string }[]>`select p.id from properties p where ${where} order by ${order} limit ${f.limit} offset ${(f.page - 1) * f.limit}`;
  return { data: await publicRows(tx, ids.map((row) => row.id)), total: Number(count!.total) };
}

export async function identifyCandidates(tx: Tx, terms: string[]) {
  if (!terms.length) return { data: [], total: 0 };
  const where = Prisma.join([TENANT_FILTER, ...terms.map((term) => termMatch(IDENTITY_TEXT, term))], " AND ");
  const [count] = await tx.$queryRaw<{ total: bigint }[]>`select count(*) as total from properties p where ${where}`;
  const ids = await tx.$queryRaw<{ id: string }[]>`select p.id from properties p where ${where} order by p.id limit 5`;
  return { data: await publicRows(tx, ids.map((row) => row.id)), total: Number(count!.total) };
}

export async function propertyCatalog(tx: Tx) {
  return tx.property.findMany({
    where: { estado: { in: ["disponible", "privado"] } },
    select: { ciudad: true, zona: true }, distinct: ["ciudad", "zona"],
    orderBy: [{ ciudad: "asc" }, { zona: "asc" }]
  });
}

const PROPERTY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Trae UNA propiedad por id o slug (tool ver_propiedad). Mismo SELECT que la
 * búsqueda — sin `notas` ni `user_id` — más la portada. NO filtra por estado a
 * propósito: el agente tiene que poder decir "esa ya se reservó" en vez de
 * negar algo que ofreció. RLS `prop_select` ya la acota al tenant del contexto
 * 'agent'.
 */
export function findPropertyByIdOrSlug(tx: Tx, idOrSlug: string) {
  const where: Prisma.PropertyWhereUniqueInput = PROPERTY_UUID_RE.test(idOrSlug)
    ? { id: idOrSlug }
    : { slug: idOrSlug };
  return tx.property.findUnique({
    where,
    select: {
      ...AGENT_PROPERTY_SELECT,
      images: { where: { esPortada: true }, select: { url: true }, take: 1 }
    }
  });
}

export function findTenantSitio(tx: Tx, tenantId: string) {
  return tx.tenant.findUnique({ where: { id: tenantId }, select: { configSitio: true } });
}

export function findTenantFollowupSettings(tx: Tx, tenantId: string) {
  return tx.tenant.findUnique({
    where: { id: tenantId },
    select: {
      estado: true,
      agentEnabled: true,
      followupEnabled: true,
      followupFirstMessage: true,
      followupSecondMessage: true
    }
  });
}

// ── Conversaciones ───────────────────────────────────────────────────────────
export const CONVERSATION_SELECT = {
  id: true,
  leadId: true,
  canal: true,
  canalRef: true,
  channelAccountId: true,
  providerConversationId: true,
  estado: true,
  vendedorId: true,
  followupStep: true,
  followupDueAt: true,
  followupClaimedAt: true,
  lastLeadMessageAt: true,
  intencion: true,
  tipoPropiedad: true,
  ciudad: true,
  zonas: true,
  presupuestoMin: true,
  presupuestoMax: true,
  moneda: true,
  dormitoriosMin: true,
  propertyId: true,
  temperatura: true,
  resumen: true,
  resumenAt: true,
  createdAt: true,
  updatedAt: true,
  tenant: { select: { agentEnabled: true } }
} satisfies Prisma.ConversationSelect;

export function findConversacionViva(
  tx: Tx,
  canal: "whatsapp" | "web",
  canalRef: string
) {
  return tx.conversation.findFirst({
    where: { canal, canalRef, estado: { not: "cerrada" } },
    select: CONVERSATION_SELECT
  });
}

export function findConversacionVivaPorProveedor(
  tx: Tx,
  channelAccountId: string,
  providerConversationId: string
) {
  return tx.conversation.findFirst({
    where: {
      channelAccountId,
      providerConversationId,
      estado: { not: "cerrada" }
    },
    select: CONVERSATION_SELECT
  });
}

export function findConversacionLegada(
  tx: Tx,
  canal: "whatsapp" | "web",
  canalRef: string
) {
  return tx.conversation.findFirst({
    where: {
      canal,
      canalRef,
      channelAccountId: null,
      providerConversationId: null,
      estado: { not: "cerrada" }
    },
    select: CONVERSATION_SELECT
  });
}

export function findActiveChannelAccount(tx: Tx, id: string) {
  return tx.channelAccount.findFirst({
    where: { id, estado: "activa" },
    select: { id: true, canal: true, zernioAccountId: true }
  });
}

export function findConversacion(tx: Tx, id: string) {
  return tx.conversation.findUnique({ where: { id }, select: CONVERSATION_SELECT });
}

export function insertConversacion(tx: Tx, data: Prisma.ConversationUncheckedCreateInput) {
  return tx.conversation.create({ data, select: CONVERSATION_SELECT });
}

export function updateConversacion(tx: Tx, id: string, data: Prisma.ConversationUpdateInput) {
  return tx.conversation.update({ where: { id }, data, select: CONVERSATION_SELECT });
}

// ── Mensajes ─────────────────────────────────────────────────────────────────
export const MESSAGE_SELECT = {
  id: true,
  rol: true,
  tipo: true,
  contenido: true,
  mediaUrl: true,
  createdAt: true
} satisfies Prisma.ConversationMessageSelect;

export interface MensajeNuevo {
  tenantId: string;
  conversationId: string;
  rol: "lead" | "agente_ia" | "vendedor" | "sistema";
  tipo: "texto" | "audio" | "imagen" | "documento" | "plantilla";
  contenido: string;
  mediaUrl: string | null;
  providerMessageId?: string | null;
  meta?: Record<string, unknown>;
}

export function insertMensajes(tx: Tx, data: MensajeNuevo[]) {
  return tx.conversationMessage.createMany({
    data: data.map((m) => ({ ...m, meta: aJson(m.meta) }))
  });
}

/**
 * Prisma tipa las columnas jsonb como `InputJsonValue`, que no acepta
 * `Record<string, unknown>`: un `unknown` podría no ser serializable y el
 * compilador no tiene cómo descartarlo. Acá sí lo sabemos — esto viene de un
 * body HTTP que ya pasó por Zod, o sea que es JSON por construcción. El cast
 * queda encerrado en esta función en vez de repetirse en cada llamada.
 */
export function aJson(v: unknown): Prisma.InputJsonValue | undefined {
  return v === undefined || v === null ? undefined : (v as Prisma.InputJsonValue);
}

/** Últimos K, devueltos en orden cronológico (que es como los lee el modelo). */
export async function ultimosMensajes(tx: Tx, conversationId: string, k: number) {
  const filas = await tx.conversationMessage.findMany({
    where: { conversationId },
    select: MESSAGE_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: k
  });
  return filas.reverse();
}

/** Total real de mensajes, independiente del limite usado para el contexto del modelo. */
export function contarMensajes(tx: Tx, conversationId: string) {
  return tx.conversationMessage.count({ where: { conversationId } });
}

/** Mensajes posteriores al ultimo resumen, para no depender de una ventana truncada. */
export function contarMensajesDesde(tx: Tx, conversationId: string, desde: Date | null) {
  return tx.conversationMessage.count({
    where: { conversationId, ...(desde ? { createdAt: { gt: desde } } : {}) }
  });
}

export function listarMensajes(tx: Tx, conversationId: string, after?: bigint) {
  return tx.conversationMessage.findMany({
    where: { conversationId, ...(after !== undefined ? { id: { gt: after } } : {}) },
    select: MESSAGE_SELECT,
    orderBy: { id: "asc" },
    take: 500
  });
}

// ── Vendedores y reparto ─────────────────────────────────────────────────────
/**
 * Da de alta en el reparto a los vendedores del tenant que todavía no estén.
 * Sin esto, el primer handoff fallaría por tabla vacía y cada alta de personal
 * exigiría un paso manual que alguien se va a olvidar.
 */
export async function sincronizarVendedores(tx: Tx, tenantId: string) {
  return assignment.syncActiveSellers(tx, tenantId);
}

export function listarVendedores(tx: Tx, tenantId: string) {
  return tx.vendedorAgente.findMany({
    where: { tenantId },
    select: {
      userId: true,
      activo: true,
      ultimoAsignadoAt: true,
      leadsAsignadosCount: true,
      user: { select: { nombre: true, email: true } }
    },
    orderBy: { ultimoAsignadoAt: "asc" }
  });
}

export function setVendedorActivo(tx: Tx, tenantId: string, userId: string, activo: boolean) {
  return tx.vendedorAgente.updateMany({ where: { userId, tenantId }, data: { activo } });
}

/**
 * Elige a quién le toca: activo, de este tenant, el que hace más tiempo que no
 * recibe (los que nunca recibieron primero), desempatando **al azar**.
 *
 * El azar puro repartiría mal en muestras chicas (con 30 vendedores y ~10
 * consultas por día alguien se come cuatro seguidas). Ordenar por antigüedad
 * garantiza equidad; el random() del desempate hace que el vendedor no pueda
 * predecir su turno. `for update skip locked` evita que dos derivaciones
 * simultáneas caigan sobre el mismo.
 */
export async function elegirVendedor(
  tx: Tx,
  tenantId: string,
  excluir: string[] = []
): Promise<string | null> {
  return assignment.chooseSeller(tx, tenantId, excluir);
}

export function marcarAsignado(tx: Tx, userId: string) {
  return assignment.markAssigned(tx, userId);
}

// ── Handoffs ─────────────────────────────────────────────────────────────────
export function insertHandoff(tx: Tx, data: Prisma.HandoffUncheckedCreateInput) {
  return tx.handoff.create({
    data,
    select: { id: true, resultado: true, asignadoAt: true, vendedorId: true }
  });
}

export function vendedoresPrevios(tx: Tx, conversationId: string) {
  return tx.handoff.findMany({
    where: { conversationId },
    select: { vendedorId: true }
  });
}

export function handoffsPendientes(tx: Tx, tenantId: string) {
  return tx.handoff.findMany({
    where: { tenantId, resultado: "pendiente", reassignable: true },
    select: {
      id: true,
      conversationId: true,
      vendedorId: true,
      motivo: true,
      asignadoAt: true
    },
    orderBy: { asignadoAt: "asc" },
    take: 200
  });
}

export function cerrarHandoff(
  tx: Tx,
  id: string,
  resultado: "tomado" | "timeout_reasignado" | "rechazado"
) {
  return tx.handoff.updateMany({
    where: { id, resultado: "pendiente" },
    data: { resultado, ...(resultado === "tomado" ? { tomadoAt: new Date() } : {}) }
  });
}

export function handoffPendienteDe(tx: Tx, conversationId: string) {
  return tx.handoff.findFirst({
    where: { conversationId, resultado: "pendiente" },
    orderBy: { asignadoAt: "desc" },
    select: { id: true, vendedorId: true }
  });
}

// ── Leads ────────────────────────────────────────────────────────────────────
export function insertLead(tx: Tx, data: Prisma.LeadUncheckedCreateInput) {
  return tx.lead.create({ data });
}

export function findLead(tx: Tx, id: string) {
  return tx.lead.findUnique({ where: { id } });
}

// `updateMany` no acepta relaciones anidadas (`assignee: { connect }`): hay que
// escribir el escalar. Por eso el tipo es Unchecked y no LeadUpdateInput.
// Se usa updateMany y no update para que RLS pueda devolver 0 filas en vez de
// tirar excepción cuando la fila no es visible.
export function updateLead(tx: Tx, id: string, data: Prisma.LeadUncheckedUpdateInput) {
  return tx.lead.updateMany({ where: { id }, data });
}

export function insertNotaDelAgente(tx: Tx, tenantId: string, leadId: string, nota: string) {
  return tx.leadNote.create({
    data: { tenantId, leadId, origen: "agente", nota }
  });
}

export function findVendedor(tx: Tx, id: string) {
  return tx.user.findUnique({
    where: { id },
    select: { id: true, nombre: true, email: true }
  });
}
