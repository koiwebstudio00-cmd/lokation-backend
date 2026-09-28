// Agente de IA — lo que consume n8n con API key, más lo que consume el panel
// con sesión. Ver lamelas-agent/docs/contrato-agente-api.md v2.1.
//
// Principio del módulo: n8n habla, esto recuerda y decide. Todo lo que sea
// estado (quién es el lead, qué se dijo, a quién le tocó) vive acá, para que
// n8n pueda caerse y volver sin perder nada.
import { ApiError } from "../../lib/errors.js";
import { emitEvent } from "../../lib/events.js";
import { minutosHabilesEntre } from "../../lib/horario.js";
import { sendMail, type Mail } from "../../lib/mailer.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import type { AccessClaims } from "../../lib/tokens.js";
import { config } from "../../config.js";
import { takeLeadInTx } from "../crm/service.js";
import * as repo from "./repo.js";
import { perfilAColumnas, renderResumen, type Resumen } from "./resumen.js";
import { identityTerms, normalizeSearchText, resolvePropertyType, zoneAlternatives } from "./property-search.js";
import { TIPOS } from "../../lib/property-opciones.js";
import * as followups from "./followup.repo.js";

const agentCtx = (tenantId: string) => ({ rol: "agent" as const, tenantId });
const FOLLOWUP_DELAY_MS = 2 * 60 * 60 * 1000;
const FOLLOWUP_RETRY_MS = 5 * 60 * 1000;
const sessionCtx = (a: AccessClaims) => ({
  userId: a.userId,
  tenantId: a.tenantId,
  rol: a.rol
});

// ── Serialización ────────────────────────────────────────────────────────────
// Decimal y BigInt no sobreviven a res.json(): el primero saldría como objeto y
// el segundo directamente tira TypeError. Se convierten acá, una sola vez.
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function mensajePayload(m: {
  id: bigint;
  rol: string;
  tipo: string;
  contenido: string;
  mediaUrl: string | null;
  createdAt: Date;
}) {
  return {
    id: String(m.id),
    rol: m.rol,
    tipo: m.tipo,
    contenido: m.contenido,
    media_url: m.mediaUrl,
    creado_at: m.createdAt
  };
}

type ConversationRow = Awaited<ReturnType<typeof repo.findConversacion>>;

function conversacionPayload(c: NonNullable<ConversationRow>) {
  return {
    id: c.id,
    lead_id: c.leadId,
    canal: c.canal,
    canal_ref: c.canalRef,
    channel_account_id: c.channelAccountId,
    provider_conversation_id: c.providerConversationId,
    estado: c.estado,
    bot_activo: c.estado === "bot" && c.tenant.agentEnabled,
    vendedor_id: c.vendedorId,
    perfil: {
      intencion: c.intencion,
      tipo_propiedad: c.tipoPropiedad,
      ciudad: c.ciudad,
      zonas: c.zonas,
      presupuesto_min: num(c.presupuestoMin),
      presupuesto_max: num(c.presupuestoMax),
      moneda: c.moneda,
      dormitorios_min: c.dormitoriosMin,
      property_id: c.propertyId,
      temperatura: c.temperatura
    },
    resumen: c.resumen,
    resumen_at: c.resumenAt,
    creada_at: c.createdAt
  };
}

// ── Propiedades: base del sitio y payload compartido ─────────────────────────
// El link que el agente le manda al lead sale de la config del tenant; si no
// está cargada, se cae al default de config y, si tampoco hay slug, se omite en
// vez de inventar un dominio.
function baseSitio(tenant: { configSitio: unknown } | null): string {
  const sitio = (tenant?.configSitio as { url_publica?: string } | null)?.url_publica;
  return (sitio ?? config.SITIO_PUBLICO_URL).replace(/\/+$/, "");
}

type PropertyRow = NonNullable<Awaited<ReturnType<typeof repo.findPropertyByIdOrSlug>>>;

function propertyPayload(p: PropertyRow, base: string) {
  return {
    id: p.id,
    slug: p.slug,
    titulo: p.titulo,
    operacion: p.operacion,
    tipo: p.tipo,
    precio: num(p.precio),
    moneda: p.moneda,
    // operacion=ambos: precio/moneda = venta; estos = alquiler (nulos si no aplica).
    precio_alquiler: num(p.precioAlquiler),
    moneda_alquiler: p.monedaAlquiler,
    estado: p.estado,
    destacada: p.destacada,
    descripcion: p.descripcion,
    requisitos: p.requisitos,
    direccion: p.direccion,
    zona: p.zona,
    ciudad: p.ciudad,
    ambientes: p.ambientes,
    dormitorios: p.dormitorios,
    banios: p.banios,
    sup_cubierta: num(p.supCubierta),
    sup_total: num(p.supTotal),
    // Datos de alquiler (nulos en venta): Sofi responde con esto.
    destino: p.destino,
    plazo_contrato: p.plazoContrato,
    plazo_otro: p.plazoOtro,
    ajuste: p.ajuste,
    ajuste_otro: p.ajusteOtro,
    indice_ajuste: p.indiceAjuste,
    indice_fijo_pct: num(p.indiceFijoPct),
    expensas: p.expensas,
    mascotas: p.mascotas,
    amoblado: p.amoblado,
    lat: num(p.lat),
    lng: num(p.lng),
    link_maps: p.linkMaps,
    link_publico: base && p.slug ? `${base}/propiedades/${p.slug}` : null,
    foto_portada: p.images[0]?.url ?? null
  };
}

// ── Tool: buscar_propiedades ─────────────────────────────────────────────────
export async function buscarPropiedades(tenantId: string, f: repo.AgentPropertyFilters) {
  return runWithContext(agentCtx(tenantId), async (tx) => {
    const [{ data, total }, tenant] = await Promise.all([
      repo.searchProperties(tx, f),
      repo.findTenantSitio(tx, tenantId)
    ]);

    const base = baseSitio(tenant);
    return {
      data: data.map((p) => ({ ...propertyPayload(p, base),
        precio_consulta: num(f.operacion === "alquiler" && p.operacion === "ambos" ? p.precioAlquiler : p.precio),
        moneda_consulta: f.operacion === "alquiler" && p.operacion === "ambos" ? p.monedaAlquiler : p.moneda
      })),
      meta: { page: f.page, limit: f.limit, total,
        filtros_aplicados: { q: f.q ?? null, operacion: f.operacion ?? null, tipo: resolvePropertyType(f.tipo) ?? null,
          estados: f.estado ? [f.estado] : ["disponible", "privado"], sort: f.sort ?? "recent",
          zonas: zoneAlternatives(f.zona, f.zonas), ciudad: f.ciudad ?? null,
          moneda: f.moneda ?? null, precio_min: f.precioMin ?? null, precio_max: f.precioMax ?? null,
          dormitorios_min: f.dormitorios ?? null, dormitorios_max: f.dormitoriosMax ?? null,
          ambientes: f.ambientes ?? null, ambientes_exactos: f.ambientesExactos ?? null,
          mascotas: f.mascotas ?? null, amoblado: f.amoblado ?? null,
          excluir_ids: f.excluirIds ?? [], excluir_slugs: f.excluirSlugs ?? [] },
        advertencias: [
          ...(f.tipo && !resolvePropertyType(f.tipo) ? ["Tipo no reconocido: no se aplicó ese filtro."] : []),
          ...(f.precioMin !== undefined || f.precioMax !== undefined ? ["El filtro de precio no incluye expensas ni otros gastos."] : []),
          ...(!f.moneda && (f.precioMin !== undefined || f.precioMax !== undefined || f.sort?.startsWith("price")) ? ["Falta indicar moneda; los importes de distintas monedas no son comparables."] : [])
        ]
      }
    };
  });
}

export async function catalogoPropiedades(tenantId: string) {
  return runWithContext(agentCtx(tenantId), async (tx) => ({ tipos: TIPOS, ubicaciones: await repo.propertyCatalog(tx) }));
}

export async function identificarPropiedad(tenantId: string, reference: string) {
  return runWithContext(agentCtx(tenantId), async (tx) => {
    const base = baseSitio(await repo.findTenantSitio(tx, tenantId));
    let key = reference;
    let direct = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(key) || /^(venta|alquiler|ambos)-[a-z0-9-]+$/.test(key);
    if (/^https?:\/\//i.test(reference)) {
      const missing = { resultado: "no_identificada", propiedad: null, candidatos: [], total: 0 };
      try {
        const url = new URL(reference);
        if (url.hostname.replace(/^www\./, "") !== new URL(base).hostname.replace(/^www\./, ""))
          return { ...missing, motivo: "El enlace es externo; se necesita dirección u otra referencia. No se abrió la URL." };
        const match = url.pathname.match(/^\/propiedades\/([^/]+)\/?$/);
        if (!match) return missing;
        key = decodeURIComponent(match[1]!);
        direct = true;
      } catch { return missing; }
    }
    if (direct) {
      const property = await repo.findPropertyByIdOrSlug(tx, key);
      return { resultado: property ? "identificada" : "no_identificada", propiedad: property ? propertyPayload(property, base) : null, candidatos: [], total: property ? 1 : 0 };
    }
    const terms = identityTerms(reference);
    let found = await repo.identifyCandidates(tx, terms);
    let relaxed = false;
    if (!found.total && terms.some((term) => /^\d+$/.test(term))) {
      found = await repo.identifyCandidates(tx, terms.filter((term) => !/^\d+$/.test(term)));
      relaxed = true;
    }
    const first = found.data[0];
    const address = ` ${normalizeSearchText(first?.direccion ?? "")} `;
    const exactTitle = first && normalizeSearchText(first.titulo) === normalizeSearchText(reference);
    const specificAddress = terms.length >= 2 && terms.some((term) => /^\d+$/.test(term)) &&
      !/\bal\s+\d+\b/i.test(reference) && terms.every((term) => /^\d+$/.test(term) ? address.includes(` ${term} `) : address.includes(term));
    const identified = found.total === 1 && !relaxed && (exactTitle || specificAddress);
    return {
      resultado: identified ? "identificada" : found.total ? "ambigua" : "no_identificada",
      propiedad: identified ? propertyPayload(first!, base) : null,
      candidatos: identified ? [] : found.data.map((property) => propertyPayload(property, base)),
      total: found.total,
      motivo: identified ? "Coincidencia de referencia dentro del inventario." : relaxed && found.total
        ? "Hay referencias similares, pero la altura no coincide. Confirmar con el cliente; no asumir que es la misma unidad."
        : found.total ? "La referencia no identifica inequívocamente una unidad. Pedir una aclaración." : "No se identificó la propiedad. Esto no confirma que no esté disponible."
    };
  });
}

// ── Tool: ver_propiedad ──────────────────────────────────────────────────────
// Trae UNA propiedad por slug o id. Es la forma confiable de recuperar algo que
// el agente ya le mostró al lead (para pasarle el link o más datos), sin
// depender de que una búsqueda difusa vuelva a encontrarla. Devuelve la
// propiedad con su `estado` aunque no esté disponible: así el agente puede
// avisar que se reservó en vez de negar que exista.
export async function verPropiedad(tenantId: string, idOrSlug: string) {
  return runWithContext(agentCtx(tenantId), async (tx) => {
    const [prop, tenant] = await Promise.all([
      repo.findPropertyByIdOrSlug(tx, idOrSlug),
      repo.findTenantSitio(tx, tenantId)
    ]);
    if (!prop) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    return { property: propertyPayload(prop, baseSitio(tenant)) };
  });
}

// ── Abrir o recuperar conversación ───────────────────────────────────────────
export interface AbrirInput {
  canal: "whatsapp" | "web";
  canalRef: string;
  nombre?: string;
  propertyId?: string;
  mensaje?: string;
  channelAccountId?: string;
  providerConversationId?: string;
}

export async function abrirConversacion(tenantId: string, input: AbrirInput) {
  return runWithContext(agentCtx(tenantId), async (tx) => {
    const tieneIdentidad = Boolean(input.channelAccountId && input.providerConversationId);
    if (tieneIdentidad) {
      if (input.canal !== "whatsapp") {
        throw new ApiError("VALIDATION_ERROR", "La identidad de proveedor sólo aplica a WhatsApp.");
      }
      const cuenta = await repo.findActiveChannelAccount(tx, input.channelAccountId!);
      if (!cuenta || cuenta.canal !== "whatsapp") {
        throw new ApiError("NOT_FOUND", "La cuenta de WhatsApp no existe o no está activa.");
      }
    }

    let viva = tieneIdentidad
      ? await repo.findConversacionVivaPorProveedor(
          tx,
          input.channelAccountId!,
          input.providerConversationId!
        )
      : await repo.findConversacionViva(tx, input.canal, input.canalRef);

    // Primera entrada posterior a la adopción: reutiliza la conversación
    // existente y le agrega la identidad Zernio, sin duplicar lead ni chat.
    if (!viva && tieneIdentidad) {
      const legada = await repo.findConversacionLegada(tx, input.canal, input.canalRef);
      if (legada) {
        viva = await repo.updateConversacion(tx, legada.id, {
          channelAccount: { connect: { id: input.channelAccountId! } },
          providerConversationId: input.providerConversationId
        });
      }
    }
    if (viva) {
      const lead = await repo.findLead(tx, viva.leadId);
      return {
        conversation: conversacionPayload(viva),
        lead: leadPayload(lead!),
        creada: false
      };
    }

    // Si vino por el link de una propiedad, tiene que ser del tenant de la key.
    let propertyId: string | null = null;
    if (input.propertyId) {
      const prop = await tx.property.findFirst({
        where: { id: input.propertyId, tenantId },
        select: { id: true }
      });
      if (!prop) throw new ApiError("NOT_FOUND", "El recurso no existe.");
      propertyId = prop.id;
    }

    const lead = await repo.insertLead(tx, {
      tenantId,
      propertyId,
      canal: input.canal,
      canalRef: input.canalRef,
      nombre: input.nombre?.trim() || nombreProvisorio(input.canal),
      telefono: input.canal === "whatsapp" ? input.canalRef : null,
      // El primer mensaje del lead. Si todavía no dijo nada (el widget web
      // abre la sesión antes de que escriba), queda una marca legible en vez
      // de un string vacío, que sería raro en la ficha del panel.
      mensaje: input.mensaje?.trim() || "(consulta iniciada por WhatsApp)"
    });

    const conversation = await repo.insertConversacion(tx, {
      tenantId,
      leadId: lead.id,
      canal: input.canal,
      canalRef: input.canalRef,
      channelAccountId: input.channelAccountId ?? null,
      providerConversationId: input.providerConversationId ?? null,
      propertyId
    });

    await emitEvent(tx, "lead.created", leadPayload(lead));

    // Sin notificación por email acá: el lead todavía no tiene vendedor y no
    // sabemos si el agente va a derivarlo. El aviso sale en el handoff.
    return { conversation: conversacionPayload(conversation), lead: leadPayload(lead), creada: true };
  });
}

function nombreProvisorio(canal: string): string {
  return canal === "whatsapp" ? "Contacto de WhatsApp" : "Visitante del sitio";
}

function leadPayload(l: {
  id: string;
  tenantId: string;
  propertyId: string | null;
  assignedTo: string | null;
  canal: string;
  canalRef: string | null;
  nombre: string;
  email: string | null;
  telefono: string | null;
  mensaje: string;
  estado: string;
}) {
  return {
    id: l.id,
    tenant_id: l.tenantId,
    property_id: l.propertyId,
    assigned_to: l.assignedTo,
    canal: l.canal,
    canal_ref: l.canalRef,
    nombre: l.nombre,
    email: l.email,
    telefono: l.telefono,
    mensaje: l.mensaje,
    estado: l.estado
  };
}

// ── Mensajes ─────────────────────────────────────────────────────────────────
export interface MensajeInput {
  rol: "lead" | "agente_ia" | "vendedor" | "sistema";
  tipo?: "texto" | "audio" | "imagen" | "documento" | "plantilla";
  contenido: string;
  mediaUrl?: string;
  meta?: Record<string, unknown>;
}

export async function registrarMensajes(
  tenantId: string,
  conversationId: string,
  mensajes: MensajeInput[]
) {
  return runWithContext(agentCtx(tenantId), async (tx) => {
    let conv = await requireConversacion(tx, conversationId);
    const { count } = await repo.insertMensajes(
      tx,
      mensajes.map((m) => ({
        tenantId,
        conversationId,
        rol: m.rol,
        tipo: m.tipo ?? "texto",
        contenido: m.contenido,
        mediaUrl: m.mediaUrl ?? null,
        meta: m.meta
      }))
    );

    const now = new Date();
    let lastLeadIndex = -1;
    let lastAgentIndex = -1;
    mensajes.forEach((message, index) => {
      if (message.rol === "lead") lastLeadIndex = index;
      if (message.rol === "agente_ia") lastAgentIndex = index;
    });
    const lastAgent = lastAgentIndex >= 0 ? mensajes[lastAgentIndex] : undefined;
    const automaticFollowup = lastAgent?.meta?.automatic_followup === true;

    if (lastLeadIndex >= 0) {
      conv = await repo.updateConversacion(tx, conversationId, {
        lastLeadMessageAt: now,
        followupStep: 0,
        followupDueAt: null,
        followupClaimedAt: null
      });
    }

    // El mensaje normal de Sofi abre la ventana. Los mensajes del propio
    // worker llevan metadata y avanzan su paso por una operación atómica
    // separada, por lo que nunca deben reiniciar el reloj desde el paso 1.
    if (
      conv.canal === "whatsapp" &&
      conv.estado === "bot" &&
      conv.tenant.agentEnabled &&
      conv.channelAccountId &&
      conv.providerConversationId &&
      lastAgentIndex > lastLeadIndex &&
      !automaticFollowup
    ) {
      const settings = await repo.findTenantFollowupSettings(tx, tenantId);
      if (settings?.followupEnabled) {
        conv = await repo.updateConversacion(tx, conversationId, {
          followupStep: 1,
          followupDueAt: new Date(now.getTime() + FOLLOWUP_DELAY_MS),
          followupClaimedAt: null
        });
      }
    }
    return { creados: count, conversation: conversacionPayload(conv) };
  });
}

async function requireConversacion(tx: Tx, id: string) {
  const conv = await repo.findConversacion(tx, id);
  if (!conv) throw new ApiError("NOT_FOUND", "El recurso no existe.");
  return conv;
}

// ── Contexto para el modelo ──────────────────────────────────────────────────
export async function contextoDelModelo(tenantId: string, conversationId: string, k: number) {
  return runWithContext(agentCtx(tenantId), async (tx) => {
    const conv = await requireConversacion(tx, conversationId);
    const [mensajes, mensajesTotal, mensajesDesdeResumen, lead, ubicaciones] = await Promise.all([
      repo.ultimosMensajes(tx, conversationId, k),
      repo.contarMensajes(tx, conversationId),
      repo.contarMensajesDesde(tx, conversationId, conv.resumenAt),
      repo.findLead(tx, conv.leadId),
      repo.propertyCatalog(tx)
    ]);
    return {
      conversation: conversacionPayload(conv),
      resumen: conv.resumen,
      catalogo_propiedades: { tipos: TIPOS, ubicaciones },
      mensajes: mensajes.map(mensajePayload),
      mensajes_total: mensajesTotal,
      mensajes_desde_resumen: mensajesDesdeResumen,
      lead: { id: lead!.id, nombre: lead!.nombre }
    };
  });
}

// ── Resumen periódico ────────────────────────────────────────────────────────
export async function guardarResumen(
  tenantId: string,
  conversationId: string,
  resumen: Resumen
) {
  return runWithContext(agentCtx(tenantId), async (tx) => {
    await requireConversacion(tx, conversationId);
    const conv = await repo.updateConversacion(tx, conversationId, {
      ...perfilAColumnas(resumen),
      resumen: repo.aJson(resumen),
      resumenAt: new Date()
    });
    // La clasificación (potencial/fantasma) vive en el lead, no en la
    // conversación: es la métrica del negocio y también aplica a leads manuales.
    if (resumen.clasificacion === "potencial") {
      await repo.updateLead(tx, conv.leadId, { clasificacion: "potencial" });
    }
    return conversacionPayload(conv);
  });
}

// ── Derivación ───────────────────────────────────────────────────────────────
export async function derivar(
  tenantId: string,
  conversationId: string,
  input: { motivo: string; resumen?: Resumen }
) {
  const { response, mail } = await runWithContext(agentCtx(tenantId), async (tx) => {
    const conv = await requireConversacion(tx, conversationId);
    if (conv.estado === "cerrada") {
      throw new ApiError("CONFLICT", "La conversación ya está cerrada.");
    }

    await repo.sincronizarVendedores(tx, tenantId);
    const vendedorId = await repo.elegirVendedor(tx, tenantId);
    if (!vendedorId) {
      throw new ApiError(
        "CONFLICT",
        "No hay vendedores disponibles para tomar la consulta."
      );
    }

    const asignado = await asignar(tx, {
      tenantId,
      conversationId,
      leadId: conv.leadId,
      vendedorId,
      motivo: input.motivo,
      resumen: input.resumen
    });

    return {
      response: {
        handoff: {
          id: asignado.handoff.id,
          resultado: asignado.handoff.resultado,
          asignado_at: asignado.handoff.asignadoAt
        },
        vendedor: asignado.vendedor,
        conversation: conversacionPayload(asignado.conversation),
        lead: { id: conv.leadId, estado: "en_contacto", assigned_to: vendedorId }
      },
      mail: asignado.mail
    };
  });
  if (mail) await sendMail(mail);
  return response;
}

/**
 * El corazón del handoff, compartido entre la derivación y la reasignación por
 * timeout. Todo pasa en la transacción del caller: elegir, asignar, dejar el
 * brief y encolar el evento de webhook. Devuelve el correo listo para que el
 * caller lo envíe después del commit: nunca se espera SMTP dentro de la tx.
 */
async function asignar(
  tx: Tx,
  p: {
    tenantId: string;
    conversationId: string;
    leadId: string;
    vendedorId: string;
    motivo: string;
    resumen?: Resumen;
    reassignable?: boolean;
    clasificacion?: "potencial" | "fantasma";
  }
) {
  await repo.marcarAsignado(tx, p.vendedorId);

  const conversation = await repo.updateConversacion(tx, p.conversationId, {
    estado: "esperando_humano",
    vendedor: { connect: { id: p.vendedorId } },
    followupStep: 0,
    followupDueAt: null,
    followupClaimedAt: null,
    ...(p.resumen
      ? { ...perfilAColumnas(p.resumen), resumen: repo.aJson(p.resumen), resumenAt: new Date() }
      : {})
  });

  await repo.updateLead(tx, p.leadId, {
    estado: "en_contacto",
    assignedTo: p.vendedorId,
    ...(p.clasificacion ? { clasificacion: p.clasificacion } : {})
  });

  const handoff = await repo.insertHandoff(tx, {
    tenantId: p.tenantId,
    conversationId: p.conversationId,
    vendedorId: p.vendedorId,
    motivo: p.motivo,
    reassignable: p.reassignable ?? true
  });

  const vendedor = await repo.findVendedor(tx, p.vendedorId);
  const lead = await repo.findLead(tx, p.leadId);

  // El brief queda como nota del lead: el vendedor lo encuentra donde ya mira.
  const brief = p.resumen ? renderResumen(p.resumen) : null;
  if (brief) await repo.insertNotaDelAgente(tx, p.tenantId, p.leadId, brief);

  await emitEvent(tx, "lead.assigned", {
    lead_id: p.leadId,
    conversation_id: p.conversationId,
    vendedor_id: p.vendedorId,
    motivo: p.motivo,
    handoff_id: handoff.id
  });

  const mail: Mail | null = vendedor && lead
    ? {
      to: vendedor.email,
      subject: `Consulta nueva de ${lead.nombre} (${p.motivo})`,
      text:
        `Te asignamos una consulta que venía atendiendo el agente.\n\n` +
        `Nombre: ${lead.nombre}\nTeléfono: ${lead.telefono ?? "-"}\n\n` +
        `${brief ?? "(sin resumen todavía)"}\n\n` +
        `Verla y tomarla: ${config.FRONT_URL}/consultas/${p.leadId}`
    }
    : null;

  return { handoff, conversation, vendedor, mail };
}

/**
 * Último paso del seguimiento: bajo lock confirma que el lead siguió en
 * silencio, lo marca fantasma y lo deriva una única vez. Si momentáneamente no
 * hay vendedor, conserva a Sofi y reintenta: nunca deja el lead varado.
 */
export async function finalizarSeguimientoFantasma(
  tenantId: string,
  conversationId: string,
  claimedAt: Date,
  now = new Date()
) {
  const { result, mail } = await runWithContext(agentCtx(tenantId), async (tx) => {
    if (!(await followups.lock(tx, conversationId))) {
      return { result: { assigned: false, reason: "not_found" }, mail: null };
    }
    const conv = await repo.findConversacion(tx, conversationId);
    if (
      !conv ||
      conv.estado !== "bot" ||
      conv.followupStep !== 3 ||
      conv.followupClaimedAt?.getTime() !== claimedAt.getTime() ||
      !conv.followupDueAt ||
      conv.followupDueAt > now
    ) {
      return { result: { assigned: false, reason: "cancelled" }, mail: null };
    }

    await repo.sincronizarVendedores(tx, tenantId);
    const vendedorId = await repo.elegirVendedor(tx, tenantId);
    if (!vendedorId) {
      await followups.retryLater(
        tx,
        conversationId,
        claimedAt,
        new Date(now.getTime() + FOLLOWUP_RETRY_MS)
      );
      return { result: { assigned: false, reason: "no_seller" }, mail: null };
    }

    const assigned = await asignar(tx, {
      tenantId,
      conversationId,
      leadId: conv.leadId,
      vendedorId,
      motivo: "seguimiento_sin_respuesta",
      reassignable: false,
      clasificacion: "fantasma"
    });
    return {
      result: {
        assigned: true,
        leadId: conv.leadId,
        sellerId: vendedorId,
        handoffId: assigned.handoff.id
      },
      mail: assigned.mail
    };
  });
  if (mail) await sendMail(mail);
  return result;
}

// ── Vendedores ───────────────────────────────────────────────────────────────
export async function listarVendedores(tenantId: string) {
  return runWithContext(agentCtx(tenantId), async (tx) => {
    await repo.sincronizarVendedores(tx, tenantId);
    const filas = await repo.listarVendedores(tx, tenantId);
    return filas.map((v) => ({
      id: v.userId,
      nombre: v.user.nombre,
      email: v.user.email,
      activo: v.activo,
      ultimo_asignado_at: v.ultimoAsignadoAt,
      leads_asignados_count: v.leadsAsignadosCount
    }));
  });
}

export async function setDisponibilidad(tenantId: string, userId: string, activo: boolean) {
  return runWithContext(agentCtx(tenantId), async (tx) => {
    await repo.sincronizarVendedores(tx, tenantId);
    const { count } = await repo.setVendedorActivo(tx, tenantId, userId, activo);
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    return { id: userId, activo };
  });
}

// ── Timeout de toma ──────────────────────────────────────────────────────────
/**
 * Lo llama el cron de n8n cada pocos minutos. Un handoff que nadie tomó en
 * HANDOFF_TIMEOUT_MIN minutos **hábiles** se reasigna al siguiente del reparto,
 * excluyendo a todos los que ya lo tuvieron: si no, el mismo lead podría
 * volver a caerle a quien ya lo dejó pasar.
 *
 * La señal de "lo tomé" vive en el lead. La registran los endpoints de toma del
 * panel y el worker cuando Zernio informa una salida de WhatsApp Business App.
 * Llamadas o contactos desde otro número siguen sin ser observables; por eso el
 * timeout mantiene un margen de 60 minutos hábiles.
 */
export async function procesarVencidos(tenantId: string) {
  const { response, mails } = await runWithContext(agentCtx(tenantId), async (tx) => {
    const pendientes = await repo.handoffsPendientes(tx, tenantId);
    const ahora = new Date();
    const reasignados: unknown[] = [];
    const mails: Mail[] = [];

    for (const h of pendientes) {
      if (minutosHabilesEntre(h.asignadoAt, ahora) < config.HANDOFF_TIMEOUT_MIN) continue;

      const conv = await repo.findConversacion(tx, h.conversationId);
      // Si mientras tanto alguien la tomó o se cerró, el handoff se cierra sin
      // reasignar: el reloj perdió sentido.
      if (!conv || conv.estado !== "esperando_humano") {
        await repo.cerrarHandoff(tx, h.id, "rechazado");
        continue;
      }

      const lead = await repo.findLead(tx, conv.leadId);
      if (!lead || lead.tomadoAt) {
        await repo.cerrarHandoff(tx, h.id, lead?.tomadoAt ? "tomado" : "rechazado");
        continue;
      }

      const previos = await repo.vendedoresPrevios(tx, h.conversationId);
      const excluir = [...new Set(previos.map((p) => p.vendedorId))];
      const siguiente = await repo.elegirVendedor(tx, tenantId, excluir);

      await repo.cerrarHandoff(tx, h.id, "timeout_reasignado");

      if (!siguiente) {
        // Dieron toda la vuelta y nadie la tomó. Se deja como está y se
        // reporta: es un problema de gestión, no algo que resuelva reasignando.
        reasignados.push({
          conversation_id: h.conversationId,
          anterior: h.vendedorId,
          nuevo: null,
          motivo: "sin_vendedores_disponibles"
        });
        continue;
      }

      const asignado = await asignar(tx, {
        tenantId,
        conversationId: h.conversationId,
        leadId: conv.leadId,
        vendedorId: siguiente,
        motivo: h.motivo
      });
      if (asignado.mail) mails.push(asignado.mail);

      reasignados.push({
        conversation_id: h.conversationId,
        lead_id: conv.leadId,
        anterior: h.vendedorId,
        nuevo: siguiente,
        vendedor: asignado.vendedor,
        handoff_id: asignado.handoff.id
      });
    }

    return {
      response: { revisados: pendientes.length, reasignados },
      mails
    };
  });
  for (const mail of mails) await sendMail(mail);
  return response;
}

// ── Panel (sesión de vendedor/admin) ─────────────────────────────────────────
export async function listarConversaciones(
  auth: AccessClaims,
  f: { leadId?: string; estado?: string; page: number; limit: number }
) {
  return runWithContext(sessionCtx(auth), async (tx) => {
    const where = {
      ...(f.leadId ? { leadId: f.leadId } : {}),
      ...(f.estado ? { estado: f.estado as "bot" } : {})
    };
    const [filas, total] = await Promise.all([
      tx.conversation.findMany({
        where,
        select: repo.CONVERSATION_SELECT,
        orderBy: { updatedAt: "desc" },
        skip: (f.page - 1) * f.limit,
        take: f.limit
      }),
      tx.conversation.count({ where })
    ]);
    return {
      data: filas.map(conversacionPayload),
      meta: { page: f.page, limit: f.limit, total }
    };
  });
}

export async function mensajesDeConversacion(
  auth: AccessClaims,
  conversationId: string,
  after?: bigint
) {
  return runWithContext(sessionCtx(auth), async (tx) => {
    await requireConversacion(tx, conversationId);
    const filas = await repo.listarMensajes(tx, conversationId, after);
    return { data: filas.map(mensajePayload) };
  });
}

/** El vendedor toma el chat: el bot queda mudo y se frena el timeout. */
export async function tomarConversacion(auth: AccessClaims, conversationId: string) {
  return runWithContext(sessionCtx(auth), async (tx) => {
    const conv = await requireConversacion(tx, conversationId);
    if (conv.estado === "cerrada") {
      throw new ApiError("CONFLICT", "La conversación ya está cerrada.");
    }

    await takeLeadInTx(tx, auth, conv.leadId);

    // El lead puede haber sido tomado antes que este chat (por ejemplo, desde
    // el CRM). La auditoría de esa primera toma no se sobrescribe, pero tomar
    // la conversación igualmente debe silenciar al bot.
    const pending = await repo.handoffPendienteDe(tx, conversationId);
    if (pending) await repo.cerrarHandoff(tx, pending.id, "tomado");

    const updated = await repo.updateConversacion(tx, conversationId, {
      estado: "humano",
      vendedor: { connect: { id: auth.userId } }
    });
    return conversacionPayload(updated);
  });
}

/** Devolver el chat al bot (se atendió por otro lado, o fue un falso positivo). */
export async function liberarConversacion(auth: AccessClaims, conversationId: string) {
  return runWithContext(sessionCtx(auth), async (tx) => {
    await requireConversacion(tx, conversationId);
    const conv = await repo.updateConversacion(tx, conversationId, { estado: "bot" });
    return conversacionPayload(conv);
  });
}
