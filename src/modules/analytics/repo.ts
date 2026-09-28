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
    where c.created_at >= (${f.from}::date::timestamp at time zone ${f.timezone})
      and c.created_at < ((${f.to}::date + 1)::timestamp at time zone ${f.timezone})
      ${f.canal ? Prisma.sql`and l.canal = ${f.canal}::lead_canal` : Prisma.empty}
      ${f.clasificacion ? Prisma.sql`and l.clasificacion = ${f.clasificacion}::lead_clasificacion` : Prisma.empty}
      ${propertyFilters(f)}
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
    where p.estado = 'disponible'
      ${f.sellerId ? Prisma.sql`and p.user_id = ${f.sellerId}::uuid` : Prisma.empty}
      ${f.operacion ? Prisma.sql`and p.operacion = ${f.operacion}::operacion_enum` : Prisma.empty}
      ${f.tipo ? Prisma.sql`and p.tipo = ${f.tipo}::tipo_enum` : Prisma.empty}
      ${f.zona ? Prisma.sql`and lower(coalesce(p.zona, '')) = lower(${f.zona})` : Prisma.empty}
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
