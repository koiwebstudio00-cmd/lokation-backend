import { ApiError } from "../../lib/errors.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import { deleteObjects, newImageKey, presignUpload, publicUrl } from "../../lib/r2.js";
import type { AccessClaims } from "../../lib/tokens.js";

const MAX_FOTOS = 20;

const ctxOf = (a: AccessClaims) => ({
  userId: a.userId,
  tenantId: a.tenantId,
  rol: a.rol
});

/** La propiedad debe ser visible y editable por el usuario (RLS filtra). */
async function editableProperty(tx: Tx, auth: AccessClaims, propertyId: string) {
  const property = await tx.property.findUnique({ where: { id: propertyId } });
  if (!property) throw new ApiError("NOT_FOUND", "El recurso no existe.");
  if (auth.rol === "agente" && property.userId !== auth.userId) {
    throw new ApiError("FORBIDDEN", "Solo el creador puede gestionar las fotos.");
  }
  return property;
}

export async function presign(auth: AccessClaims, propertyId: string, count: number) {
  return runWithContext(ctxOf(auth), async (tx) => {
    await editableProperty(tx, auth, propertyId);
    const existing = await tx.propertyImage.count({ where: { propertyId } });
    if (existing + count > MAX_FOTOS) {
      throw new ApiError(
        "LIMIT_EXCEEDED",
        `Máximo ${MAX_FOTOS} fotos por propiedad (tenés ${existing}).`
      );
    }
    return Promise.all(
      Array.from({ length: count }, async () => {
        const r2Key = newImageKey(auth.tenantId!, propertyId);
        return { r2_key: r2Key, upload_url: await presignUpload(r2Key) };
      })
    );
  });
}

export async function confirm(auth: AccessClaims, propertyId: string, r2Keys: string[]) {
  return runWithContext(ctxOf(auth), async (tx) => {
    await editableProperty(tx, auth, propertyId);

    // Las keys deben pertenecer a esta propiedad (las generó presign).
    const prefix = `${auth.tenantId}/${propertyId}/`;
    if (r2Keys.some((k) => !k.startsWith(prefix))) {
      throw new ApiError("VALIDATION_ERROR", "Alguna key no corresponde a esta propiedad.");
    }

    const existing = await tx.propertyImage.count({ where: { propertyId } });
    if (existing + r2Keys.length > MAX_FOTOS) {
      throw new ApiError("LIMIT_EXCEEDED", `Máximo ${MAX_FOTOS} fotos por propiedad.`);
    }

    const hasPortada = existing > 0
      ? Boolean(await tx.propertyImage.findFirst({ where: { propertyId, esPortada: true } }))
      : false;
    const maxOrden = await tx.propertyImage.aggregate({
      where: { propertyId },
      _max: { orden: true }
    });
    let orden = (maxOrden._max.orden ?? -1) + 1;

    const created = [];
    for (const [i, r2Key] of r2Keys.entries()) {
      created.push(
        await tx.propertyImage.create({
          data: {
            tenantId: auth.tenantId!,
            propertyId,
            r2Key,
            url: publicUrl(r2Key),
            esPortada: !hasPortada && i === 0,
            orden: orden++
          }
        })
      );
    }
    return created;
  });
}

export async function setPortada(auth: AccessClaims, imageId: string) {
  return runWithContext(ctxOf(auth), async (tx) => {
    const image = await tx.propertyImage.findUnique({ where: { id: imageId } });
    if (!image) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    await editableProperty(tx, auth, image.propertyId);
    await tx.propertyImage.updateMany({
      where: { propertyId: image.propertyId, esPortada: true },
      data: { esPortada: false }
    });
    return tx.propertyImage.update({ where: { id: imageId }, data: { esPortada: true } });
  });
}

export async function reorder(auth: AccessClaims, propertyId: string, ids: string[]) {
  return runWithContext(ctxOf(auth), async (tx) => {
    await editableProperty(tx, auth, propertyId);
    const images = await tx.propertyImage.findMany({ where: { propertyId } });
    const validIds = new Set(images.map((i: { id: string }) => i.id));
    if (ids.length !== images.length || ids.some((id) => !validIds.has(id))) {
      throw new ApiError("VALIDATION_ERROR", "La lista debe incluir todas las fotos de la propiedad.");
    }
    for (const [orden, id] of ids.entries()) {
      await tx.propertyImage.update({ where: { id }, data: { orden } });
    }
    return tx.propertyImage.findMany({ where: { propertyId }, orderBy: { orden: "asc" } });
  });
}

export async function removeImage(auth: AccessClaims, imageId: string) {
  const r2Key = await runWithContext(ctxOf(auth), async (tx) => {
    const image = await tx.propertyImage.findUnique({ where: { id: imageId } });
    if (!image) throw new ApiError("NOT_FOUND", "El recurso no existe.");
    await editableProperty(tx, auth, image.propertyId);
    await tx.propertyImage.delete({ where: { id: imageId } });

    // Si era la portada, promover la siguiente por orden.
    if (image.esPortada) {
      const next = await tx.propertyImage.findFirst({
        where: { propertyId: image.propertyId },
        orderBy: { orden: "asc" }
      });
      if (next) {
        await tx.propertyImage.update({ where: { id: next.id }, data: { esPortada: true } });
      }
    }
    return image.r2Key;
  });
  await deleteObjects([r2Key]);
}
