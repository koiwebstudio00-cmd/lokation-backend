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
    cohort_definition: "Leads creados dentro del período, observados en su estado actual."
  };
}

export async function overview(auth: AccessClaims, filters: AnalyticsFilters) {
  return runWithContext(context(auth), async (tx) => {
    const [leads, conversations, properties] = await Promise.all([
      repo.overviewLeads(tx, filters),
      repo.overviewConversations(tx, filters),
      repo.overviewProperties(tx, filters)
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
      }
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
      topProperties
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
      repo.topPropertiesByLeads(tx, filters)
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
