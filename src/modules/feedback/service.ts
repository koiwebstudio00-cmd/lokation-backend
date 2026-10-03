// Feedback — sugerencias y reportes de error de los usuarios del panel.
// Un solo módulo con discriminador `tipo`. Solo los reportes ('error') aceptan
// adjuntos (imágenes en R2). RLS es la autorización real (ver migración 0014):
// super_admin ve todo, admin su tenant, el agente solo lo propio.
import { ApiError } from "../../lib/errors.js";
import { sendMail } from "../../lib/mailer.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import { deleteObjects, newAttachmentKey, presignUpload, publicUrl, verifyUploadedObject } from "../../lib/r2.js";
import type { AccessClaims } from "../../lib/tokens.js";
import { config } from "../../config.js";

const MAX_ADJUNTOS = 6;

const ctxOf = (a: AccessClaims) => ({
  userId: a.userId,
  tenantId: a.tenantId,
  rol: a.rol
});

export type FeedbackTipo = "sugerencia" | "error";
export type FeedbackEstado =
  | "nuevo"
  | "en_revision"
  | "planificada"
  | "resuelta"
  | "descartada";

// Autor + contadores: es lo que muestra el listado de un vistazo.
const ITEM_INCLUDE = {
  autor: { select: { id: true, nombre: true } },
  _count: { select: { adjuntos: true, comentarios: true } }
} as const;

export interface FeedbackFilters {
  tipo?: FeedbackTipo;
  estado?: FeedbackEstado;
  q?: string;
  page: number;
  limit: number;
}

export async function listFeedback(auth: AccessClaims, f: FeedbackFilters) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const where = {
      ...(f.tipo ? { tipo: f.tipo } : {}),
      ...(f.estado ? { estado: f.estado } : {}),
      ...(f.q
        ? {
            OR: [
              { titulo: { contains: f.q, mode: "insensitive" as const } },
              { descripcion: { contains: f.q, mode: "insensitive" as const } }
            ]
          }
        : {})
    };
    const [data, total] = await Promise.all([
      tx.feedbackItem.findMany({
        where,
        include: ITEM_INCLUDE,
        orderBy: { createdAt: "desc" },
        skip: (f.page - 1) * f.limit,
        take: f.limit
      }),
      tx.feedbackItem.count({ where })
    ]);
    return { data, meta: { page: f.page, limit: f.limit, total } };
  });
}

export async function createFeedback(
  auth: AccessClaims,
  data: {
    tipo: FeedbackTipo;
    titulo: string;
    descripcion: string;
    urlContexto?: string;
    userAgent?: string;
  }
) {
  // El super_admin no tiene tenant: no crea feedback, solo lo triagea.
  if (!auth.tenantId) {
    throw new ApiError("FORBIDDEN", "Solo los usuarios de una inmobiliaria pueden dejar feedback.");
  }
  return runWithContext(ctxOf(auth), async (tx) => {
    const item = await tx.feedbackItem.create({
      data: {
        tenantId: auth.tenantId!,
        autorId: auth.userId,
        tipo: data.tipo,
        titulo: data.titulo,
        descripcion: data.descripcion,
        urlContexto: data.urlContexto ?? null,
        userAgent: data.userAgent ?? null
      },
      include: ITEM_INCLUDE
    });
    // Los reportes de error suelen ser urgentes: se avisa a los admins del tenant.
    if (data.tipo === "error") await notifyAdmins(tx, auth.tenantId!, item);
    return item;
  });
}

async function notifyAdmins(
  tx: Tx,
  tenantId: string,
  item: { id: string; titulo: string; descripcion: string }
) {
  const admins = await tx.user.findMany({
    where: { tenantId, rol: "admin", estado: "activo" },
    select: { email: true }
  });
  for (const a of admins) {
    await sendMail({
      to: a.email,
      subject: `Nuevo reporte de error: ${item.titulo}`,
      text:
        `Un usuario reportó un error en el sistema.\n\n` +
        `${item.titulo}\n\n${item.descripcion}\n\n` +
        `Verlo: ${config.FRONT_URL}/feedback/${item.id}`
    });
  }
}

export async function getFeedback(auth: AccessClaims, id: string) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const item = await tx.feedbackItem.findUnique({
      where: { id },
      include: {
        autor: { select: { id: true, nombre: true } },
        adjuntos: { orderBy: { orden: "asc" } },
        // Sin include del autor del comentario: un comentario del super_admin
        // (Koi) apunta a un usuario que el tenant NO puede ver por RLS, y Prisma
        // rompe con "Field autor is required" al no poder resolver la relación
        // obligatoria. Resolvemos los nombres aparte (los visibles) y caemos a
        // "Soporte" para los que el que mira no puede ver.
        comentarios: {
          orderBy: { createdAt: "asc" },
          select: { id: true, autorId: true, cuerpo: true, createdAt: true }
        }
      }
    });
    // RLS filtra: si no es visible, findUnique devuelve null → 404.
    if (!item) throw new ApiError("NOT_FOUND", "El recurso no existe.");

    const autorIds = [...new Set(item.comentarios.map((c) => c.autorId))];
    const autores = autorIds.length
      ? await tx.user.findMany({ where: { id: { in: autorIds } }, select: { id: true, nombre: true } })
      : [];
    const nombrePorId = new Map(autores.map((u) => [u.id, u.nombre]));

    return {
      ...item,
      comentarios: item.comentarios.map((c) => ({
        id: c.id,
        cuerpo: c.cuerpo,
        createdAt: c.createdAt,
        autor: { id: c.autorId, nombre: nombrePorId.get(c.autorId) ?? "Soporte" }
      }))
    };
  });
}

export async function updateFeedbackEstado(
  auth: AccessClaims,
  id: string,
  estado: FeedbackEstado
) {
  return runWithContext(ctxOf(auth), async (tx) => {
    // updateMany (no update) para que RLS devuelva 0 filas en vez de excepción.
    const { count } = await tx.feedbackItem.updateMany({ where: { id }, data: { estado } });
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    return (await tx.feedbackItem.findUnique({ where: { id }, include: ITEM_INCLUDE }))!;
  });
}

/** Borra el ítem (cascade limpia adjuntos y comentarios). Devuelve las keys de R2. */
export async function deleteFeedback(auth: AccessClaims, id: string) {
  const r2Keys = await runWithContext(ctxOf(auth), async (tx) => {
    const adjuntos = await tx.feedbackAdjunto.findMany({
      where: { feedbackId: id },
      select: { r2Key: true }
    });
    const { count } = await tx.feedbackItem.deleteMany({ where: { id } });
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    return adjuntos.map((a) => a.r2Key);
  });
  await deleteObjects(r2Keys);
}

export async function addComentario(auth: AccessClaims, feedbackId: string, cuerpo: string) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const item = await tx.feedbackItem.findUnique({
      where: { id: feedbackId },
      select: { id: true, tenantId: true }
    });
    if (!item) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    // El comentario lleva el tenant del ítem, no el del autor: así el super_admin
    // (sin tenant) también puede comentar. La policy lo valida.
    return tx.feedbackComentario.create({
      data: { tenantId: item.tenantId, feedbackId, autorId: auth.userId, cuerpo },
      include: { autor: { select: { id: true, nombre: true } } }
    });
  });
}

// ── Adjuntos (solo reportes de error) ────────────────────────────────────────

/** El ítem tiene que ser un reporte visible que el usuario pueda editar. */
async function itemParaAdjunto(tx: Tx, auth: AccessClaims, feedbackId: string) {
  const item = await tx.feedbackItem.findUnique({ where: { id: feedbackId } });
  if (!item) throw new ApiError("NOT_FOUND", "El recurso no existe.");
  if (item.tipo !== "error") {
    throw new ApiError("VALIDATION_ERROR", "Solo los reportes de error aceptan imágenes.");
  }
  const esAutor = item.autorId === auth.userId;
  const esAdmin = auth.rol === "admin" || auth.rol === "super_admin";
  if (!esAutor && !esAdmin) {
    throw new ApiError("FORBIDDEN", "No podés adjuntar imágenes a este reporte.");
  }
  return item;
}

export async function presignAdjuntos(auth: AccessClaims, feedbackId: string, count: number) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const item = await itemParaAdjunto(tx, auth, feedbackId);
    const existing = await tx.feedbackAdjunto.count({ where: { feedbackId } });
    if (existing + count > MAX_ADJUNTOS) {
      throw new ApiError(
        "LIMIT_EXCEEDED",
        `Máximo ${MAX_ADJUNTOS} imágenes por reporte (tenés ${existing}).`
      );
    }
    return Promise.all(
      Array.from({ length: count }, async () => {
        const r2Key = newAttachmentKey(item.tenantId, feedbackId);
        return { r2_key: r2Key, upload_url: await presignUpload(r2Key) };
      })
    );
  });
}

export async function confirmAdjuntos(auth: AccessClaims, feedbackId: string, r2Keys: string[]) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const item = await itemParaAdjunto(tx, auth, feedbackId);

    const prefix = `${item.tenantId}/feedback/${feedbackId}/`;
    if (r2Keys.some((k) => !k.startsWith(prefix))) {
      throw new ApiError("VALIDATION_ERROR", "Alguna key no corresponde a este reporte.");
    }

    const existing = await tx.feedbackAdjunto.count({ where: { feedbackId } });
    if (existing + r2Keys.length > MAX_ADJUNTOS) {
      throw new ApiError("LIMIT_EXCEEDED", `Máximo ${MAX_ADJUNTOS} imágenes por reporte.`);
    }

    const maxOrden = await tx.feedbackAdjunto.aggregate({
      where: { feedbackId },
      _max: { orden: true }
    });
    let orden = (maxOrden._max.orden ?? -1) + 1;

    const created = [];
    for (const key of r2Keys) await verifyUploadedObject(key);
    for (const r2Key of r2Keys) {
      created.push(
        await tx.feedbackAdjunto.create({
          data: { tenantId: item.tenantId, feedbackId, r2Key, url: publicUrl(r2Key), orden: orden++ }
        })
      );
    }
    return created;
  });
}

export async function removeAdjunto(auth: AccessClaims, adjuntoId: string) {
  const r2Key = await runWithContext(ctxOf(auth), async (tx) => {
    const adjunto = await tx.feedbackAdjunto.findUnique({ where: { id: adjuntoId } });
    if (!adjunto) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    const { count } = await tx.feedbackAdjunto.deleteMany({ where: { id: adjuntoId } });
    if (count === 0) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    return adjunto.r2Key;
  });
  await deleteObjects([r2Key]);
}
