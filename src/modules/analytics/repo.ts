import { Prisma } from "@prisma/client";
import type { Tx } from "../../lib/prisma.js";

export interface AnalyticsFilters {
  from: string;
  to: string;
  timezone: string;
  canal?: "web" | "whatsapp" | "instagram" | "messenger" | "manual";
  sellerId?: string;
  operacion?: "venta" | "alquiler" | "ambos";
  tipo?:
    | "monoambiente"
    | "departamento"
    | "casa"
    | "duplex"
    | "local_comercial"
    | "oficina"
    | "galpon"
    | "estacionamiento"
    | "terreno"
    | "otro";
  zona?: string;
  clasificacion?: "potencial" | "fantasma";
  /** Período contra el que se comparan los KPIs (mes calendario anterior o
   * la misma cantidad de días inmediatamente antes). Lo resuelve routes.ts. */
  previous?: { from: string; to: string };
}

/** Los mismos filtros, apuntados al período de comparación. */
export function previousFilters(f: AnalyticsFilters): AnalyticsFilters | null {
  if (!f.previous) return null;
  return { ...f, from: f.previous.from, to: f.previous.to, previous: undefined };
}

function propertyFilters(f: AnalyticsFilters) {
  return Prisma.sql`
    ${f.sellerId ? Prisma.sql`and l.assigned_to = ${f.sellerId}::uuid` : Prisma.empty}
    ${f.operacion ? Prisma.sql`and p.operacion = ${f.operacion}::operacion_enum` : Prisma.empty}
    ${f.tipo ? Prisma.sql`and p.tipo = ${f.tipo}::tipo_enum` : Prisma.empty}
    ${f.zona ? Prisma.sql`and lower(coalesce(p.zona, '')) = lower(${f.zona})` : Prisma.empty}
  `;
}

function leadWhere(f: AnalyticsFilters) {
  return Prisma.sql`
    l.created_at >= (${f.from}::date::timestamp at time zone ${f.timezone})
    and l.created_at < ((${f.to}::date + 1)::timestamp at time zone ${f.timezone})
    and not (l.canal = 'web' and l.canal_ref is not null)
    ${f.canal ? Prisma.sql`and l.canal = ${f.canal}::lead_canal` : Prisma.empty}
    ${f.clasificacion ? Prisma.sql`and l.clasificacion = ${f.clasificacion}::lead_clasificacion` : Prisma.empty}
    ${propertyFilters(f)}
  `;
}

// Conversaciones de Agente IA iniciadas en el período. Igual que leadWhere, deja
// afuera el probador del panel (lead web con canal_ref): son pruebas, no
// clientes. Requiere los alias c (conversations), l (leads) y p (properties).
function conversationWhere(f: AnalyticsFilters) {
  return Prisma.sql`
    c.created_at >= (${f.from}::date::timestamp at time zone ${f.timezone})
    and c.created_at < ((${f.to}::date + 1)::timestamp at time zone ${f.timezone})
    and not (l.canal = 'web' and l.canal_ref is not null)
    ${f.canal ? Prisma.sql`and l.canal = ${f.canal}::lead_canal` : Prisma.empty}
    ${f.clasificacion ? Prisma.sql`and l.clasificacion = ${f.clasificacion}::lead_clasificacion` : Prisma.empty}
    ${propertyFilters(f)}
  `;
}

// Filtros de inventario: la propiedad es de quien la cargó (user_id), no del
// vendedor asignado a un lead.
function inventoryFilters(f: AnalyticsFilters) {
  return Prisma.sql`
    ${f.sellerId ? Prisma.sql`and p.user_id = ${f.sellerId}::uuid` : Prisma.empty}
    ${f.operacion ? Prisma.sql`and p.operacion = ${f.operacion}::operacion_enum` : Prisma.empty}
    ${f.tipo ? Prisma.sql`and p.tipo = ${f.tipo}::tipo_enum` : Prisma.empty}
    ${f.zona ? Prisma.sql`and lower(coalesce(p.zona, '')) = lower(${f.zona})` : Prisma.empty}
  `;
}

export interface OverviewLeadRow {
  leadsCreated: number;
  leadsTaken: number;
  medianTakeMinutes: number | null;
  nuevas: number;
  enContacto: number;
  ganadas: number;
  perdidas: number;
}

export async function overviewLeads(tx: Tx, f: AnalyticsFilters) {
  const rows = await tx.$queryRaw<OverviewLeadRow[]>(Prisma.sql`
    select
      count(*)::int as "leadsCreated",
      count(*) filter (where l.tomado_at is not null)::int as "leadsTaken",
      percentile_cont(0.5) within group (
        order by extract(epoch from (l.tomado_at - l.created_at)) / 60.0
      ) filter (where l.tomado_at is not null)::double precision as "medianTakeMinutes",
      count(*) filter (where l.estado = 'nueva')::int as nuevas,
      count(*) filter (where l.estado = 'en_contacto')::int as "enContacto",
      count(*) filter (where l.estado = 'ganada')::int as ganadas,
      count(*) filter (where l.estado = 'perdida')::int as perdidas
    from leads l
    left join properties p on p.id = l.property_id
    where ${leadWhere(f)}
  `);
  return rows[0]!;
}

export interface OverviewConversationRow {
  conversations: number;
  handedOff: number;
}

export async function overviewConversations(tx: Tx, f: AnalyticsFilters) {
  const rows = await tx.$queryRaw<OverviewConversationRow[]>(Prisma.sql`
    select
      count(distinct c.id)::int as conversations,
      count(distinct c.id) filter (
        where exists (select 1 from handoffs h where h.conversation_id = c.id)
      )::int as "handedOff"
    from conversations c
    join leads l on l.id = c.lead_id
    left join properties p on p.id = l.property_id
    where ${conversationWhere(f)}
  `);
  return rows[0]!;
}

export interface OverviewPropertyRow {
  active: number;
  withoutLeads: number;
}

export async function overviewProperties(tx: Tx, f: AnalyticsFilters) {
  const rows = await tx.$queryRaw<OverviewPropertyRow[]>(Prisma.sql`
    select
      count(*)::int as active,
      count(*) filter (
        where not exists (select 1 from leads lead where lead.property_id = p.id)
      )::int as "withoutLeads"
    from properties p
    where p.estado = 'disponible' ${inventoryFilters(f)}
  `);
  return rows[0]!;
}

export interface BreakdownRow {
  key: string;
  count: number;
}

export function leadsByChannel(tx: Tx, f: AnalyticsFilters) {
  return tx.$queryRaw<BreakdownRow[]>(Prisma.sql`
    select l.canal::text as key, count(*)::int as count
    from leads l left join properties p on p.id = l.property_id
    where ${leadWhere(f)} group by l.canal order by count desc
  `);
}

export function leadsByState(tx: Tx, f: AnalyticsFilters) {
  return tx.$queryRaw<BreakdownRow[]>(Prisma.sql`
    select l.estado::text as key, count(*)::int as count
    from leads l left join properties p on p.id = l.property_id
    where ${leadWhere(f)} group by l.estado order by count desc
  `);
}

export function leadsByClassification(tx: Tx, f: AnalyticsFilters) {
  return tx.$queryRaw<BreakdownRow[]>(Prisma.sql`
    select coalesce(l.clasificacion::text, 'sin_clasificar') as key, count(*)::int as count
    from leads l left join properties p on p.id = l.property_id
    where ${leadWhere(f)} group by coalesce(l.clasificacion::text, 'sin_clasificar') order by count desc
  `);
}

export function leadsByPropertyRelation(tx: Tx, f: AnalyticsFilters) {
  return tx.$queryRaw<BreakdownRow[]>(Prisma.sql`
    select case when l.property_id is null then 'general' else 'con_propiedad' end as key,
      count(*)::int as count
    from leads l left join properties p on p.id = l.property_id
    where ${leadWhere(f)} group by 1 order by count desc
  `);
}

export interface TopPropertyRow {
  propertyId: string;
  titulo: string;
  destacada: boolean;
  consultas: number;
}

// Ranking de propiedades por consultas recibidas en el período — para que el
// admin decida qué destacar con datos reales (ver [[destacadas]]). Excluye
// consultas generales (property_id null): acá interesa solo lo que compite
// por atención sobre una propiedad puntual. `destacada` viaja en el select
// para que se vea de un vistazo cuál de las más consultadas ya está destacada.
export function topPropertiesByLeads(tx: Tx, f: AnalyticsFilters, limit = 15) {
  return tx.$queryRaw<TopPropertyRow[]>(Prisma.sql`
    select p.id as "propertyId", p.titulo, p.destacada, count(*)::int as consultas
    from leads l
    join properties p on p.id = l.property_id
    where ${leadWhere(f)}
    group by p.id, p.titulo, p.destacada
    order by consultas desc, p.titulo asc
    limit ${limit}
  `);
}

export function leadsByTakenOrigin(tx: Tx, f: AnalyticsFilters) {
  return tx.$queryRaw<BreakdownRow[]>(Prisma.sql`
    select case
      when l.tomado_at is null then 'sin_tomar'
      when l.tomado_origen is null then 'origen_no_registrado'
      else l.tomado_origen::text
    end as key, count(*)::int as count
    from leads l left join properties p on p.id = l.property_id
    where ${leadWhere(f)} group by 1 order by count desc
  `);
}

export interface DailyChannelRow {
  date: string;
  canal: string;
  count: number;
}

export function leadsByDayAndChannel(tx: Tx, f: AnalyticsFilters) {
  return tx.$queryRaw<DailyChannelRow[]>(Prisma.sql`
    select to_char(l.created_at at time zone ${f.timezone}, 'YYYY-MM-DD') as date,
      l.canal::text as canal, count(*)::int as count
    from leads l left join properties p on p.id = l.property_id
    where ${leadWhere(f)} group by 1, l.canal order by 1 asc, l.canal asc
  `);
}

export interface LeadTimingRow {
  medianMinutes: number | null;
  p90Minutes: number | null;
  assigned: number;
  unassigned: number;
}

export async function leadTimings(tx: Tx, f: AnalyticsFilters) {
  const rows = await tx.$queryRaw<LeadTimingRow[]>(Prisma.sql`
    select
      percentile_cont(0.5) within group (
        order by extract(epoch from (l.tomado_at - l.created_at)) / 60.0
      ) filter (where l.tomado_at is not null)::double precision as "medianMinutes",
      percentile_cont(0.9) within group (
        order by extract(epoch from (l.tomado_at - l.created_at)) / 60.0
      ) filter (where l.tomado_at is not null)::double precision as "p90Minutes",
      count(*) filter (where l.assigned_to is not null)::int as assigned,
      count(*) filter (where l.assigned_to is null)::int as unassigned
    from leads l left join properties p on p.id = l.property_id
    where ${leadWhere(f)}
  `);
  return rows[0]!;
}

export interface PendingAgeRow {
  under1h: number;
  from1to4h: number;
  from4to24h: number;
  over24h: number;
}

export async function pendingByAge(tx: Tx, f: AnalyticsFilters) {
  const rows = await tx.$queryRaw<PendingAgeRow[]>(Prisma.sql`
    select
      count(*) filter (where now() - l.created_at < interval '1 hour')::int as "under1h",
      count(*) filter (where now() - l.created_at >= interval '1 hour' and now() - l.created_at < interval '4 hours')::int as "from1to4h",
      count(*) filter (where now() - l.created_at >= interval '4 hours' and now() - l.created_at < interval '24 hours')::int as "from4to24h",
      count(*) filter (where now() - l.created_at >= interval '24 hours')::int as "over24h"
    from leads l left join properties p on p.id = l.property_id
    where ${leadWhere(f)} and l.tomado_at is null
  `);
  return rows[0]!;
}

// ── Agente IA ────────────────────────────────────────────────────────────────────

export interface SofiaSummaryRow {
  conversations: number;
  handedOff: number;
  leadMessages: number;
  aiMessages: number;
  sellerMessages: number;
  medianLeadMessages: number | null;
  followedUp: number;
  recoveredByFollowup: number;
  stillWithBot: number;
}

// Una fila por período. Los seguimientos automáticos se reconocen por
// meta.automatic_followup (los escribe followup.repo.ts) y no cuentan como
// respuestas de Agente IA. "Recuperada" = el lead volvió a escribir después del
// primer seguimiento.
export async function sofiaSummary(tx: Tx, f: AnalyticsFilters) {
  const rows = await tx.$queryRaw<SofiaSummaryRow[]>(Prisma.sql`
    with conv as (
      select c.id, c.estado
      from conversations c
      join leads l on l.id = c.lead_id
      left join properties p on p.id = l.property_id
      where ${conversationWhere(f)}
    ),
    msg as (
      select m.conversation_id,
        count(*) filter (where m.rol = 'lead') as lead_msgs,
        count(*) filter (
          where m.rol = 'agente_ia' and coalesce(m.meta->>'automatic_followup', 'false') <> 'true'
        ) as ai_msgs,
        count(*) filter (where m.rol = 'vendedor') as seller_msgs,
        min(m.created_at) filter (where m.meta->>'automatic_followup' = 'true') as first_followup_at,
        max(m.created_at) filter (where m.rol = 'lead') as last_lead_at
      from conversation_messages m
      where m.conversation_id in (select id from conv)
      group by m.conversation_id
    )
    select
      count(*)::int as conversations,
      count(*) filter (
        where exists (select 1 from handoffs h where h.conversation_id = conv.id)
      )::int as "handedOff",
      coalesce(sum(msg.lead_msgs), 0)::int as "leadMessages",
      coalesce(sum(msg.ai_msgs), 0)::int as "aiMessages",
      coalesce(sum(msg.seller_msgs), 0)::int as "sellerMessages",
      percentile_cont(0.5) within group (order by coalesce(msg.lead_msgs, 0))::double precision
        as "medianLeadMessages",
      count(*) filter (where msg.first_followup_at is not null)::int as "followedUp",
      count(*) filter (
        where msg.first_followup_at is not null and msg.last_lead_at > msg.first_followup_at
      )::int as "recoveredByFollowup",
      count(*) filter (where conv.estado = 'bot')::int as "stillWithBot"
    from conv
    left join msg on msg.conversation_id = conv.id
  `);
  return rows[0]!;
}

export interface HandoffTimingRow {
  medianMinutes: number | null;
}

export async function handoffTiming(tx: Tx, f: AnalyticsFilters) {
  const rows = await tx.$queryRaw<HandoffTimingRow[]>(Prisma.sql`
    select percentile_cont(0.5) within group (
      order by extract(epoch from (h.tomado_at - h.asignado_at)) / 60.0
    ) filter (where h.tomado_at is not null)::double precision as "medianMinutes"
    from handoffs h
    join conversations c on c.id = h.conversation_id
    join leads l on l.id = c.lead_id
    left join properties p on p.id = l.property_id
    where ${conversationWhere(f)}
  `);
  return rows[0]!;
}

export function handoffsByResult(tx: Tx, f: AnalyticsFilters) {
  return tx.$queryRaw<BreakdownRow[]>(Prisma.sql`
    select h.resultado::text as key, count(*)::int as count
    from handoffs h
    join conversations c on c.id = h.conversation_id
    join leads l on l.id = c.lead_id
    left join properties p on p.id = l.property_id
    where ${conversationWhere(f)}
    group by 1 order by count desc
  `);
}

// Columnas del perfil que Agente IA extrae de la conversación (temperatura,
// intención) y la clasificación del lead. Sin dato = todavía no hubo resumen.
function conversationBreakdown(tx: Tx, f: AnalyticsFilters, column: Prisma.Sql) {
  return tx.$queryRaw<BreakdownRow[]>(Prisma.sql`
    select coalesce(${column}::text, 'sin_dato') as key, count(*)::int as count
    from conversations c
    join leads l on l.id = c.lead_id
    left join properties p on p.id = l.property_id
    where ${conversationWhere(f)}
    group by 1 order by count desc
  `);
}

export const conversationsByTemperature = (tx: Tx, f: AnalyticsFilters) =>
  conversationBreakdown(tx, f, Prisma.sql`c.temperatura`);
export const conversationsByIntent = (tx: Tx, f: AnalyticsFilters) =>
  conversationBreakdown(tx, f, Prisma.sql`c.intencion`);
export const conversationsByClassification = (tx: Tx, f: AnalyticsFilters) =>
  conversationBreakdown(tx, f, Prisma.sql`l.clasificacion`);

export interface TimeBucketRow {
  bucket: number;
  count: number;
}

/** Conversaciones iniciadas por hora del día (0–23) en la zona horaria pedida. */
export function conversationsByHour(tx: Tx, f: AnalyticsFilters) {
  return tx.$queryRaw<TimeBucketRow[]>(Prisma.sql`
    select extract(hour from c.created_at at time zone ${f.timezone})::int as bucket,
      count(*)::int as count
    from conversations c
    join leads l on l.id = c.lead_id
    left join properties p on p.id = l.property_id
    where ${conversationWhere(f)}
    group by 1 order by 1
  `);
}

/** Conversaciones iniciadas por día de semana (1 = lunes … 7 = domingo). */
export function conversationsByWeekday(tx: Tx, f: AnalyticsFilters) {
  return tx.$queryRaw<TimeBucketRow[]>(Prisma.sql`
    select extract(isodow from c.created_at at time zone ${f.timezone})::int as bucket,
      count(*)::int as count
    from conversations c
    join leads l on l.id = c.lead_id
    left join properties p on p.id = l.property_id
    where ${conversationWhere(f)}
    group by 1 order by 1
  `);
}

// ── Propiedades ──────────────────────────────────────────────────────────────

/** Foto actual del inventario (no depende del período). */
export function inventoryByState(tx: Tx, f: AnalyticsFilters) {
  return tx.$queryRaw<BreakdownRow[]>(Prisma.sql`
    select p.estado::text as key, count(*)::int as count
    from properties p
    where true ${inventoryFilters(f)}
    group by 1 order by count desc
  `);
}

export function availableByType(tx: Tx, f: AnalyticsFilters) {
  return tx.$queryRaw<BreakdownRow[]>(Prisma.sql`
    select p.tipo::text as key, count(*)::int as count
    from properties p
    where p.estado = 'disponible' ${inventoryFilters(f)}
    group by 1 order by count desc
  `);
}

export interface PropertyActivityRow {
  created: number;
  leadsWithProperty: number;
  propertiesWithLeads: number;
}

/** Altas de propiedades y consultas sobre propiedades puntuales en el período. */
export async function propertyActivity(tx: Tx, f: AnalyticsFilters) {
  const rows = await tx.$queryRaw<PropertyActivityRow[]>(Prisma.sql`
    select
      (select count(*)::int from properties p
        where p.created_at >= (${f.from}::date::timestamp at time zone ${f.timezone})
          and p.created_at < ((${f.to}::date + 1)::timestamp at time zone ${f.timezone})
          ${inventoryFilters(f)}) as created,
      (select count(*)::int from leads l join properties p on p.id = l.property_id
        where ${leadWhere(f)}) as "leadsWithProperty",
      (select count(distinct l.property_id)::int from leads l join properties p on p.id = l.property_id
        where ${leadWhere(f)}) as "propertiesWithLeads"
  `);
  return rows[0]!;
}

export function leadsByPropertyType(tx: Tx, f: AnalyticsFilters) {
  return tx.$queryRaw<BreakdownRow[]>(Prisma.sql`
    select p.tipo::text as key, count(*)::int as count
    from leads l join properties p on p.id = l.property_id
    where ${leadWhere(f)} group by 1 order by count desc
  `);
}

export function leadsByPropertyOperation(tx: Tx, f: AnalyticsFilters) {
  return tx.$queryRaw<BreakdownRow[]>(Prisma.sql`
    select p.operacion::text as key, count(*)::int as count
    from leads l join properties p on p.id = l.property_id
    where ${leadWhere(f)} group by 1 order by count desc
  `);
}

export interface ZoneDemandRow {
  zona: string;
  consultas: number;
  disponibles: number;
}

// Consultas del período vs. oferta disponible hoy, por zona. Muestra dónde
// hay más demanda que inventario (y al revés).
export function demandByZone(tx: Tx, f: AnalyticsFilters, limit = 25) {
  return tx.$queryRaw<ZoneDemandRow[]>(Prisma.sql`
    with demand as (
      select coalesce(nullif(trim(p.zona), ''), 'Sin zona') as zona, count(*)::int as consultas
      from leads l join properties p on p.id = l.property_id
      where ${leadWhere(f)}
      group by 1
    ),
    supply as (
      select coalesce(nullif(trim(p.zona), ''), 'Sin zona') as zona, count(*)::int as disponibles
      from properties p
      where p.estado = 'disponible' ${inventoryFilters(f)}
      group by 1
    )
    select coalesce(d.zona, s.zona) as zona,
      coalesce(d.consultas, 0)::int as consultas,
      coalesce(s.disponibles, 0)::int as disponibles
    from demand d
    full join supply s on s.zona = d.zona
    order by consultas desc, disponibles desc, zona asc
    limit ${limit}
  `);
}

/** Zonas que los leads le piden a Agente IA (perfil de búsqueda, texto libre). */
export function searchedZones(tx: Tx, f: AnalyticsFilters, limit = 15) {
  return tx.$queryRaw<BreakdownRow[]>(Prisma.sql`
    select initcap(lower(trim(z))) as key, count(*)::int as count
    from conversations c
    join leads l on l.id = c.lead_id
    left join properties p on p.id = l.property_id
    cross join lateral unnest(c.zonas) as z
    where ${conversationWhere(f)} and trim(z) <> ''
    group by 1 order by count desc, key asc
    limit ${limit}
  `);
}

export function searchedTypes(tx: Tx, f: AnalyticsFilters, limit = 10) {
  return tx.$queryRaw<BreakdownRow[]>(Prisma.sql`
    select lower(trim(t)) as key, count(*)::int as count
    from conversations c
    join leads l on l.id = c.lead_id
    left join properties p on p.id = l.property_id
    cross join lateral unnest(c.tipo_propiedad) as t
    where ${conversationWhere(f)} and trim(t) <> ''
    group by 1 order by count desc, key asc
    limit ${limit}
  `);
}

export interface IdlePropertyRow {
  propertyId: string;
  titulo: string;
  zona: string | null;
  operacion: string;
  tipo: string;
  createdAt: Date;
  daysPublished: number;
}

// Disponibles que no recibieron ninguna consulta en el período, las más
// antiguas primero: candidatas a revisar precio, fotos o descripción.
export function idleProperties(tx: Tx, f: AnalyticsFilters, limit = 20) {
  return tx.$queryRaw<IdlePropertyRow[]>(Prisma.sql`
    select p.id as "propertyId", p.titulo, p.zona, p.operacion::text as operacion,
      p.tipo::text as tipo, p.created_at as "createdAt",
      floor(extract(epoch from (now() - p.created_at)) / 86400)::int as "daysPublished"
    from properties p
    where p.estado = 'disponible' ${inventoryFilters(f)}
      and not exists (
        select 1 from leads l
        where l.property_id = p.id
          and l.created_at >= (${f.from}::date::timestamp at time zone ${f.timezone})
          and l.created_at < ((${f.to}::date + 1)::timestamp at time zone ${f.timezone})
      )
    order by p.created_at asc
    limit ${limit}
  `);
}

export async function idlePropertiesCount(tx: Tx, f: AnalyticsFilters) {
  const rows = await tx.$queryRaw<{ count: number }[]>(Prisma.sql`
    select count(*)::int as count
    from properties p
    where p.estado = 'disponible' ${inventoryFilters(f)}
      and not exists (
        select 1 from leads l
        where l.property_id = p.id
          and l.created_at >= (${f.from}::date::timestamp at time zone ${f.timezone})
          and l.created_at < ((${f.to}::date + 1)::timestamp at time zone ${f.timezone})
      )
  `);
  return rows[0]!.count;
}
