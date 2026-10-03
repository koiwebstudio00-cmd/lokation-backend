import { Prisma } from "@prisma/client";
import { emitEvent } from "../../lib/events.js";
import { ApiError } from "../../lib/errors.js";
import { sendMail } from "../../lib/mailer.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import type { AccessClaims } from "../../lib/tokens.js";
import * as assignment from "./assignment.repo.js";
import * as repo from "./repo.js";

const ctxOf = (a: AccessClaims) => ({
  userId: a.userId,
  tenantId: a.tenantId,
  rol: a.rol
});

// Contexto interno para la creación pública de leads (resolución de tenant por
// slug, asignación y notificación). Igual criterio que el módulo auth.
const AUTH_CTX = { rol: "auth" as const };

function leadPayload(l: {
  id: string;
  tenantId: string;
  propertyId: string | null;
  assignedTo: string | null;
  canal: string;
  nombre: string;
  email: string | null;
  telefono: string | null;
  mensaje: string;
  estado: string;
  tomadoAt: Date | null;
  tomadoPor: string | null;
  tomadoOrigen: string | null;
}) {
  return {
    id: l.id,
    tenant_id: l.tenantId,
    property_id: l.propertyId,
    assigned_to: l.assignedTo,
    canal: l.canal,
    nombre: l.nombre,
    email: l.email,
    telefono: l.telefono,
    mensaje: l.mensaje,
    estado: l.estado,
    tomado_at: l.tomadoAt,
    tomado_por: l.tomadoPor,
    tomado_origen: l.tomadoOrigen
  };
}

// Destinatarios del aviso: el vendedor asignado o, si no hay, los admins del
// tenant. Query rapida; se resuelve DENTRO de la transaccion.
function leadRecipients(tx: Tx, tenantId: string, assignedTo: string | null) {
  return assignedTo
    ? tx.user.findMany({ where: { id: assignedTo }, select: { email: true } })
    : tx.user.findMany({
        where: { tenantId, rol: "admin", estado: "activo" },
        select: { email: true }
      });
}

// Envio del aviso por email. Va SIEMPRE fuera de la transaccion: el SMTP
// (Resend) puede tardar varios segundos (handshake en frio) y, dentro de la tx
// interactiva de Prisma (timeout 5s), eso la hace expirar (P2028) y se pierde el
// lead aunque el mail salga. sendMail traga sus errores, asi que un fallo de mail
// no frena el alta.
async function sendLeadEmails(
  recipients: { email: string }[],
  lead: { nombre: string; mensaje: string; telefono: string | null; email: string | null }
) {
  for (const r of recipients) {
    await sendMail({
      to: r.email,
      subject: `Nueva consulta de ${lead.nombre}`,
      text: `Recibiste una consulta nueva.\n\nNombre: ${lead.nombre}\nEmail: ${lead.email ?? "-"}\nTeléfono: ${lead.telefono ?? "-"}\n\n${lead.mensaje}`
    });
  }
}

/** Alta pública desde formulario web (por slug del tenant). */
export async function createPublicLead(
  tenantSlug: string,
  data: {
    propertyId?: string;
    propertySlug?: string;
    nombre: string;
    email?: string;
    telefono?: string;
    mensaje: string;
  }
) {
  const tenant: { id: string; estado: string; sitePublished: boolean } | null = await runWithContext(
    AUTH_CTX,
    (tx) => tx.tenant.findUnique({ where: { slug: tenantSlug } })
  );
  if (!tenant || tenant.estado !== "activo" || (data.propertySlug && !tenant.sitePublished)) {
    throw new ApiError("NOT_FOUND", "El recurso no existe.");
  }

  // Contexto con tenant fijado: el outbox (emit_event) matchea los endpoints
  // del tenant, y RLS opera con tenant correcto. El email queda FUERA de la tx
  // (ver sendLeadEmails): adentro solo trabajo de BD, rapido.
  const { lead, recipients } = await runWithContext(
    { rol: "auth", tenantId: tenant.id },
    async (tx) => {
      // Si viene con propiedad, debe ser del tenant; se asigna al agente creador.
      let assignedTo: string | null = null;
      let propertyId: string | null = null;
      if (data.propertyId || data.propertySlug) {
        const property = await tx.property.findFirst({
          where: { tenantId: tenant.id, ...(data.propertySlug
            ? { slug: data.propertySlug, estado: "disponible" as const, ...(data.propertyId ? { id: data.propertyId } : {}) }
            : { id: data.propertyId }) }
        });
        if (!property) throw new ApiError("NOT_FOUND", "El recurso no existe.");
        propertyId = property.id;
        assignedTo = property.userId;
      } else {
        // Las consultas generales comparten el mismo turno que los handoffs del
        // agente. Si no hay vendedores disponibles, el lead se crea igual y el
        // aviso cae en los admins mediante leadRecipients.
        await assignment.syncActiveSellers(tx, tenant.id);
        assignedTo = await assignment.chooseSeller(tx, tenant.id);
        if (assignedTo) await assignment.markAssigned(tx, assignedTo);
      }

      const lead = await tx.lead.create({
        data: {
          tenantId: tenant.id,
          propertyId,
          assignedTo,
          canal: "web",
          nombre: data.nombre,
          email: data.email ?? null,
          telefono: data.telefono ?? null,
          mensaje: data.mensaje
        }
      });

      await emitEvent(tx, "lead.created", leadPayload(lead));
      const recipients = await leadRecipients(tx, tenant.id, assignedTo);
      return { lead, recipients };
    }
  );

  // Fuera de la transaccion: no bloquea el commit ni arriesga el timeout de 5s.
  await sendLeadEmails(recipients, lead);
  return { id: lead.id };
}

export interface LeadFilters {
  estado?: "nueva" | "en_contacto" | "ganada" | "perdida";
  canal?: "web" | "whatsapp" | "instagram" | "messenger" | "manual";
  clasificacion?: "potencial" | "fantasma";
  assignedTo?: string;
  propertyId?: string;
  q?: string;
  sinTomar?: boolean;
  /** true = solo leads con una derivación de Agente IA todavía sin tomar. */
  atencion?: boolean;
  excluirAgenteWeb?: boolean;
  page: number;
  limit: number;
}

export async function listLeads(auth: AccessClaims, f: LeadFilters) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const where: Prisma.LeadWhereInput = {
      ...(f.estado ? { estado: f.estado } : {}),
      ...(f.canal ? { canal: f.canal } : {}),
      ...(f.clasificacion ? { clasificacion: f.clasificacion } : {}),
      ...(f.assignedTo ? { assignedTo: f.assignedTo } : {}),
      ...(f.propertyId ? { propertyId: f.propertyId } : {}),
      ...(f.sinTomar === true
        ? { tomadoAt: null }
        : f.sinTomar === false
          ? { tomadoAt: { not: null } }
          : {}),
      // "Necesita atención": Agente IA derivó a un humano y el handoff sigue
      // pendiente. Es distinto de `sinTomar`, que mira el lead y también
      // incluye las consultas de la web (que no tienen derivación).
      ...(f.atencion === true
        ? { conversations: { some: { handoffs: { some: { resultado: "pendiente" } } } } }
        : {}),
      // Separacion agente/consultas: el panel esconde las conversaciones del
      // agente web (canal "web" con canal_ref seteado). El formulario deja
      // canal_ref en null, asi que las consultas reales quedan.
      ...(f.excluirAgenteWeb
        ? { NOT: { canal: "web", canalRef: { not: null } } }
        : {}),
      ...(f.q
        ? {
            OR: [
              { nombre: { contains: f.q, mode: "insensitive" as const } },
              { email: { contains: f.q, mode: "insensitive" as const } },
              { telefono: { contains: f.q, mode: "insensitive" as const } }
            ]
          }
        : {})
    };
    const [data, total] = await Promise.all([
      tx.lead.findMany({
        where,
        include: {
          property: { select: { id: true, titulo: true } },
          assignee: { select: { id: true, nombre: true } },
          takenBy: { select: { id: true, nombre: true } },
          // La derivación pendiente más reciente de una conversación abierta.
          // Coincide con el criterio del filtro de atención.
          conversations: {
            where: { handoffs: { some: { resultado: "pendiente" } } },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              handoffs: {
                where: { resultado: "pendiente" },
                orderBy: { asignadoAt: "desc" },
                take: 1,
                select: { motivo: true, resultado: true, asignadoAt: true }
              }
            }
          }
        },
        orderBy: { createdAt: "desc" },
        skip: (f.page - 1) * f.limit,
        take: f.limit
      }),
      tx.lead.count({ where })
    ]);
    return {
      data: data.map(({ conversations, ...lead }) => ({
        ...lead,
        derivacion: derivacionDe(conversations)
      })),
      meta: { page: f.page, limit: f.limit, total }
    };
  });
}

/**
 * Aplana la derivación pendiente del lead para el panel. `pendiente` es lo que
 * marca "necesita atención": el handoff existe y nadie lo tomó todavía.
 */
function derivacionDe(
  conversations: { handoffs: { motivo: string; resultado: string; asignadoAt: Date }[] }[]
) {
  const handoff = conversations[0]?.handoffs[0];
  if (!handoff) return null;
  return {
    motivo: handoff.motivo,
    pendiente: handoff.resultado === "pendiente",
    asignado_at: handoff.asignadoAt
  };
}

/** Alta manual (consulta telefónica, visita, etc.). */
export async function createManualLead(
  auth: AccessClaims,
  data: { nombre: string; email?: string; telefono?: string; mensaje: string; propertyId?: string }
) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const lead = await tx.lead.create({
      data: {
        tenantId: auth.tenantId!,
        propertyId: data.propertyId ?? null,
        assignedTo: auth.userId,
        canal: "manual",
        nombre: data.nombre,
        email: data.email ?? null,
        telefono: data.telefono ?? null,
        mensaje: data.mensaje
      }
    });
    await emitEvent(tx, "lead.created", leadPayload(lead));
    return lead;
  });
}

export async function getLead(auth: AccessClaims, id: string) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const lead = await tx.lead.findUnique({
      where: { id },
      include: {
        property: { select: { id: true, titulo: true, operacion: true, precio: true } },
        assignee: { select: { id: true, nombre: true } },
        takenBy: { select: { id: true, nombre: true } },
        notes: {
          orderBy: { createdAt: "desc" },
          include: { user: { select: { id: true, nombre: true } } }
        },
        // Igual que en listLeads: una derivación pendiente, aplanada para el panel.
        conversations: {
          where: { handoffs: { some: { resultado: "pendiente" } } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            handoffs: {
              where: { resultado: "pendiente" },
              orderBy: { asignadoAt: "desc" },
              take: 1,
              select: { motivo: true, resultado: true, asignadoAt: true }
            }
          }
        }
      }
    });
    if (!lead) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    const { conversations, ...rest } = lead;
    return { ...rest, derivacion: derivacionDe(conversations) };
  });
}

/**
 * Registra la primera atención de un lead y transfiere su responsabilidad a
 * quien lo toma. No cambia la etapa comercial. El lock hace que dos tomas
 * simultáneas no puedan sobrescribir quién llegó primero.
 */
export async function takeLeadInTx(tx: Tx, auth: AccessClaims, id: string) {
  const lead = await repo.lockLeadForTake(tx, id);
  if (!lead) throw new ApiError("NOT_FOUND", "El recurso no existe.");

  if (auth.rol === "agente" && lead.assignedTo && lead.assignedTo !== auth.userId) {
    throw new ApiError("FORBIDDEN", "La consulta está asignada a otro usuario.");
  }

  // Idempotencia: la primera toma es auditable y nunca se sobrescribe. El
  // permiso se valida antes para que una toma previa no habilite a un vendedor
  // ajeno a operar la conversación asociada.
  if (lead.tomadoAt) return lead;

  const assignedTo = auth.userId;
  const tomadoAt = new Date();
  const { count } = await repo.markLeadTaken(tx, id, {
    tomadoAt,
    tomadoPor: auth.userId,
    tomadoOrigen: "panel",
    assignedTo
  });
  if (count === 0) throw new ApiError("CONFLICT", "La consulta ya fue tomada.");

  const conversation = await repo.findActiveConversation(tx, id);
  if (conversation) {
    const pending = await repo.findPendingHandoff(tx, conversation.id);
    if (pending) {
      const closed = await repo.closeHandoffAsTaken(tx, pending.id, tomadoAt);
      if (closed.count === 0) {
        throw new ApiError("CONFLICT", "No se pudo cerrar la derivación pendiente.");
      }
    }
    const human = await repo.markConversationHuman(tx, conversation.id, assignedTo);
    if (human.count === 0) {
      throw new ApiError("CONFLICT", "No se pudo actualizar la conversación asociada.");
    }
  }

  const updated = await repo.findLeadAfterTake(tx, id);
  if (!updated) throw new ApiError("NOT_FOUND", "El recurso no existe.");
  await emitEvent(tx, "lead.updated", leadPayload(updated));
  return updated;
}

export async function takeLead(auth: AccessClaims, id: string) {
  return runWithContext(ctxOf(auth), (tx) => takeLeadInTx(tx, auth, id));
}

export async function updateLead(
  auth: AccessClaims,
  id: string,
  data: {
    estado?: "nueva" | "en_contacto" | "ganada" | "perdida";
    clasificacion?: "potencial" | "fantasma" | null;
    assignedTo?: string | null;
    nombre?: string;
    email?: string | null;
  }
) {
  return runWithContext(ctxOf(auth), async (tx) => {
    if (data.assignedTo !== undefined && auth.rol !== "admin") {
      throw new ApiError("FORBIDDEN", "Solo un admin puede reasignar consultas.");
    }
    if (auth.rol === "agente") {
      const current = await tx.lead.findUnique({ where: { id }, select: { assignedTo: true } });
      if (!current) throw new ApiError("NOT_FOUND", "El recurso no existe.");
      if (current.assignedTo !== auth.userId) {
        throw new ApiError("FORBIDDEN", "La consulta no está asignada a tu usuario.");
      }
    }
    const { count } = await tx.lead.updateMany({ where: { id }, data });
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    // Una clasificación manual como fantasma significa que una persona ya
    // intentó contactarlo. Se silencia a Agente IA y se cancelan los vencimientos,
    // pero no se crea una asignación automática ni se cambia el vendedor.
    if (data.clasificacion === "fantasma") {
      await repo.silenceConversationForManualGhost(tx, id);
    }
    const lead = (await tx.lead.findUnique({ where: { id } }))!;
    await emitEvent(tx, "lead.updated", leadPayload(lead));
    return lead;
  });
}

/** Borra la consulta (solo admin, ver policy `leads_delete`). Cascade limpia hijos. */
export async function deleteLead(auth: AccessClaims, id: string) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const { count } = await tx.lead.deleteMany({ where: { id } });
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
  });
}

export async function addNote(auth: AccessClaims, leadId: string, nota: string) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const lead = await tx.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    return tx.leadNote.create({
      data: { tenantId: auth.tenantId!, leadId, userId: auth.userId, nota },
      include: { user: { select: { id: true, nombre: true } } }
    });
  });
}

export async function leadStats(auth: AccessClaims) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const [porEstado, porCanal, porClasificacion] = await Promise.all([
      tx.lead.groupBy({ by: ["estado"], _count: { _all: true } }),
      tx.lead.groupBy({ by: ["canal"], _count: { _all: true } }),
      tx.lead.groupBy({ by: ["clasificacion"], _count: { _all: true } })
    ]);
    return {
      por_estado: Object.fromEntries(
        porEstado.map((e: { estado: string; _count: { _all: number } }) => [e.estado, e._count._all])
      ),
      por_canal: Object.fromEntries(
        porCanal.map((c: { canal: string; _count: { _all: number } }) => [c.canal, c._count._all])
      ),
      // clasificacion es nullable: los sin clasificar caen en la clave "null".
      por_clasificacion: Object.fromEntries(
        porClasificacion.map((c: { clasificacion: string | null; _count: { _all: number } }) => [
          c.clasificacion ?? "sin_clasificar",
          c._count._all
        ])
      )
    };
  });
}
