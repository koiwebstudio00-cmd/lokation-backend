import { runWithContext } from "../../lib/prisma.js";
import type { AccessClaims } from "../../lib/tokens.js";
import * as repo from "./repo.js";

export type AnalyticsFilters = repo.AnalyticsFilters;

const percentage = (part: number, total: number) =>
  total === 0 ? 0 : Math.round((part / total) * 1000) / 10;

const roundedMinutes = (value: number | null) =>
  value === null ? null : Math.round(value * 10) / 10;

const context = (auth: AccessClaims) => ({
  userId: auth.userId,
  tenantId: auth.tenantId,
  rol: auth.rol
});

function period(f: AnalyticsFilters) {
  return {
    from: f.from,
    to: f.to,
    timezone: f.timezone,
    previous: f.previous ?? null,
    cohort_definition: "Leads creados dentro del período, observados en su estado actual."
  };
}

/** Corre `fn` sobre el período de comparación; null si no hay. */
async function onPrevious<T>(f: AnalyticsFilters, fn: (prev: AnalyticsFilters) => Promise<T>) {
  const prev = repo.previousFilters(f);
  return prev ? fn(prev) : null;
}

function leadKpis(leads: repo.OverviewLeadRow) {
  return {
    leads_created: leads.leadsCreated,
    leads_taken: leads.leadsTaken,
    take_rate: percentage(leads.leadsTaken, leads.leadsCreated),
    median_take_minutes: roundedMinutes(leads.medianTakeMinutes),
    ganadas: leads.ganadas,
    perdidas: leads.perdidas,
    cohort_conversion_rate: percentage(leads.ganadas, leads.leadsCreated)
  };
}

function conversationKpis(conversations: repo.OverviewConversationRow) {
  return {
    sofia_conversations: conversations.conversations,
    handed_off_conversations: conversations.handedOff,
    handoff_rate: percentage(conversations.handedOff, conversations.conversations)
  };
}

export async function overview(auth: AccessClaims, filters: AnalyticsFilters) {
  return runWithContext(context(auth), async (tx) => {
    const [leads, conversations, properties, previous] = await Promise.all([
      repo.overviewLeads(tx, filters),
      repo.overviewConversations(tx, filters),
      repo.overviewProperties(tx, filters),
      onPrevious(filters, async (prev) => {
        const [prevLeads, prevConversations] = await Promise.all([
          repo.overviewLeads(tx, prev),
          repo.overviewConversations(tx, prev)
        ]);
        return { ...leadKpis(prevLeads), ...conversationKpis(prevConversations) };
      })
    ]);

    return {
      period: period(filters),
      kpis: {
        leads_created: leads.leadsCreated,
        leads_taken: leads.leadsTaken,
        take_rate: percentage(leads.leadsTaken, leads.leadsCreated),
        median_take_minutes: roundedMinutes(leads.medianTakeMinutes),
        nuevas: leads.nuevas,
        en_contacto: leads.enContacto,
        ganadas: leads.ganadas,
        perdidas: leads.perdidas,
        cohort_conversion_rate: percentage(leads.ganadas, leads.leadsCreated),
        sofia_conversations: conversations.conversations,
        handed_off_conversations: conversations.handedOff,
        handoff_rate: percentage(conversations.handedOff, conversations.conversations),
        active_properties: properties.active,
        active_properties_without_leads: properties.withoutLeads
      },
      // Mismos KPIs de flujo en el período anterior (el inventario es una foto
      // actual y no se compara).
      previous_kpis: previous
    };
  });
}

function breakdown(rows: repo.BreakdownRow[]) {
  return Object.fromEntries(rows.map((row) => [row.key, row.count]));
}

export async function leads(auth: AccessClaims, filters: AnalyticsFilters) {
  return runWithContext(context(auth), async (tx) => {
    const [
      overview,
      timings,
      byChannel,
      byState,
      byClassification,
      byProperty,
      byOrigin,
      daily,
      pending,
      topProperties,
      previous
    ] = await Promise.all([
      repo.overviewLeads(tx, filters),
      repo.leadTimings(tx, filters),
      repo.leadsByChannel(tx, filters),
      repo.leadsByState(tx, filters),
      repo.leadsByClassification(tx, filters),
      repo.leadsByPropertyRelation(tx, filters),
      repo.leadsByTakenOrigin(tx, filters),
      repo.leadsByDayAndChannel(tx, filters),
      repo.pendingByAge(tx, filters),
      repo.topPropertiesByLeads(tx, filters),
      onPrevious(filters, async (prev) => {
        const [prevOverview, prevTimings] = await Promise.all([
          repo.overviewLeads(tx, prev),
          repo.leadTimings(tx, prev)
        ]);
        return {
          total: prevOverview.leadsCreated,
          taken: prevOverview.leadsTaken,
          untaken: prevOverview.leadsCreated - prevOverview.leadsTaken,
          take_rate: percentage(prevOverview.leadsTaken, prevOverview.leadsCreated),
          median_take_minutes: roundedMinutes(prevTimings.medianMinutes),
          p90_take_minutes: roundedMinutes(prevTimings.p90Minutes)
        };
      })
    ]);

    return {
      period: period(filters),
      summary: {
        total: overview.leadsCreated,
        taken: overview.leadsTaken,
        untaken: overview.leadsCreated - overview.leadsTaken,
        take_rate: percentage(overview.leadsTaken, overview.leadsCreated),
        assigned: timings.assigned,
        unassigned: timings.unassigned,
        median_take_minutes: roundedMinutes(timings.medianMinutes),
        p90_take_minutes: roundedMinutes(timings.p90Minutes)
      },
      previous_summary: previous,
      by_channel: breakdown(byChannel),
      by_state: breakdown(byState),
      by_classification: breakdown(byClassification),
      by_property_relation: breakdown(byProperty),
      by_taken_origin: breakdown(byOrigin),
      pending_by_age: {
        under_1h: pending.under1h,
        from_1_to_4h: pending.from1to4h,
        from_4_to_24h: pending.from4to24h,
        over_24h: pending.over24h
      },
      daily: daily.map((row) => ({ date: row.date, canal: row.canal, count: row.count })),
      top_properties: topProperties.map((row) => ({
        property_id: row.propertyId,
        titulo: row.titulo,
        destacada: row.destacada,
        consultas: row.consultas
      }))
    };
  });
}

function fillBuckets(rows: repo.TimeBucketRow[], from: number, to: number) {
  const counts = new Map(rows.map((row) => [row.bucket, row.count]));
  const out: { bucket: number; count: number }[] = [];
  for (let bucket = from; bucket <= to; bucket += 1) {
    out.push({ bucket, count: counts.get(bucket) ?? 0 });
  }
  return out;
}

function sofiaKpis(row: repo.SofiaSummaryRow, handoffMedian: number | null) {
  return {
    conversations: row.conversations,
    handed_off: row.handedOff,
    handoff_rate: percentage(row.handedOff, row.conversations),
    median_handoff_take_minutes: roundedMinutes(handoffMedian),
    lead_messages: row.leadMessages,
    ai_messages: row.aiMessages,
    seller_messages: row.sellerMessages,
    median_lead_messages: row.medianLeadMessages,
    followed_up: row.followedUp,
    recovered_by_followup: row.recoveredByFollowup,
    recovery_rate: percentage(row.recoveredByFollowup, row.followedUp),
    still_with_bot: row.stillWithBot
  };
}

export async function sofia(auth: AccessClaims, filters: AnalyticsFilters) {
  return runWithContext(context(auth), async (tx) => {
    const [
      summary,
      handoffMedian,
      byHandoffResult,
      byTemperature,
      byIntent,
      byClassification,
      byHour,
      byWeekday,
      previous
    ] = await Promise.all([
      repo.sofiaSummary(tx, filters),
      repo.handoffTiming(tx, filters),
      repo.handoffsByResult(tx, filters),
      repo.conversationsByTemperature(tx, filters),
      repo.conversationsByIntent(tx, filters),
      repo.conversationsByClassification(tx, filters),
      repo.conversationsByHour(tx, filters),
      repo.conversationsByWeekday(tx, filters),
      onPrevious(filters, async (prev) => {
        const [prevSummary, prevHandoff] = await Promise.all([
          repo.sofiaSummary(tx, prev),
          repo.handoffTiming(tx, prev)
        ]);
        return sofiaKpis(prevSummary, prevHandoff.medianMinutes);
      })
    ]);

    return {
      period: period(filters),
      summary: sofiaKpis(summary, handoffMedian.medianMinutes),
      previous_summary: previous,
      by_handoff_result: breakdown(byHandoffResult),
      by_temperature: breakdown(byTemperature),
      by_intent: breakdown(byIntent),
      by_classification: breakdown(byClassification),
      by_hour: fillBuckets(byHour, 0, 23),
      by_weekday: fillBuckets(byWeekday, 1, 7)
    };
  });
}

function propertyKpis(activity: repo.PropertyActivityRow, idle: number) {
  return {
    created: activity.created,
    leads_with_property: activity.leadsWithProperty,
    properties_with_leads: activity.propertiesWithLeads,
    available_without_leads: idle
  };
}

export async function properties(auth: AccessClaims, filters: AnalyticsFilters) {
  return runWithContext(context(auth), async (tx) => {
    const [
      activity,
      idleCount,
      idle,
      byState,
      availableByType,
      leadsByType,
      leadsByOperation,
      zones,
      searchedZones,
      searchedTypes,
      topProperties,
      previous
    ] = await Promise.all([
      repo.propertyActivity(tx, filters),
      repo.idlePropertiesCount(tx, filters),
      repo.idleProperties(tx, filters),
      repo.inventoryByState(tx, filters),
      repo.availableByType(tx, filters),
      repo.leadsByPropertyType(tx, filters),
      repo.leadsByPropertyOperation(tx, filters),
      repo.demandByZone(tx, filters),
      repo.searchedZones(tx, filters),
      repo.searchedTypes(tx, filters),
      repo.topPropertiesByLeads(tx, filters),
      onPrevious(filters, async (prev) => {
        const [prevActivity, prevIdle] = await Promise.all([
          repo.propertyActivity(tx, prev),
          repo.idlePropertiesCount(tx, prev)
        ]);
        return propertyKpis(prevActivity, prevIdle);
      })
    ]);

    return {
      period: period(filters),
      summary: {
        ...propertyKpis(activity, idleCount),
        available: byState.find((row) => row.key === "disponible")?.count ?? 0
      },
      previous_summary: previous,
      inventory_by_state: breakdown(byState),
      available_by_type: breakdown(availableByType),
      leads_by_type: breakdown(leadsByType),
      leads_by_operation: breakdown(leadsByOperation),
      demand_by_zone: zones,
      searched_zones: breakdown(searchedZones),
      searched_types: breakdown(searchedTypes),
      top_properties: topProperties.map((row) => ({
        property_id: row.propertyId,
        titulo: row.titulo,
        destacada: row.destacada,
        consultas: row.consultas
      })),
      idle_properties: idle.map((row) => ({
        property_id: row.propertyId,
        titulo: row.titulo,
        zona: row.zona,
        operacion: row.operacion,
        tipo: row.tipo,
        created_at: row.createdAt.toISOString(),
        days_published: row.daysPublished
      }))
    };
  });
}
