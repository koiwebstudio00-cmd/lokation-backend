import express, { Router } from "express";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { runWithContext } from "../../lib/prisma.js";
import { detectPrivateFile, savePrivateFile, deleteRentalPdf, newDocumentKey, readRentalPdf, saveRentalPdf } from "../../lib/rental-documents-storage.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";

export const rentalDocumentRoutes = Router();
rentalDocumentRoutes.use(["/rental-contracts", "/rental-documents"], requireAuth, requireRole("admin"));
const uuid = z.string().uuid();
const metadata = z.object({ title: z.string().trim().min(3).max(160),
  kind: z.enum(["contrato", "comprobante", "inventario", "otro"]),
  visibility: z.enum(["interna", "inquilino", "propietario", "ambos"]) });
const select = { id: true, title: true, kind: true, visibility: true, size: true, mimeType: true, originalName: true, createdAt: true } as const;

// The vault uses the same tenant/RLS boundary and private download endpoint as contracts.
rentalDocumentRoutes.post("/rental-documents", express.raw({ type: "application/octet-stream", limit: "10mb" }), async (req, res) => {
  const info = z.object({ title: metadata.shape.title, kind: metadata.shape.kind,
    originalName: z.string().trim().min(1).max(255) }).parse(req.query);
  if (!Buffer.isBuffer(req.body)) throw new ApiError("VALIDATION_ERROR", "Seleccioná un archivo.");
  const type = detectPrivateFile(req.body);
  const auth = req.auth!;
  const key = newDocumentKey(auth.tenantId!, auth.userId).replace(/pdf$/, type.extension);
  await savePrivateFile(key, req.body);
  try {
    const document = await runWithContext({ tenantId: auth.tenantId!, userId: auth.userId, rol: "admin" },
      tx => tx.rentalDocument.create({ data: { ...info, tenantId: auth.tenantId!, uploadedById: auth.userId,
        visibility: "interna", mimeType: type.mime, storageKey: key, size: req.body.length }, select }));
    res.status(201).json({ document });
  } catch (error) { await deleteRentalPdf(key); throw error; }
});

rentalDocumentRoutes.get("/rental-documents", async (req, res) => {
  const query = z.object({
    q: z.string().trim().max(160).optional(),
    kind: metadata.shape.kind.optional(),
    visibility: metadata.shape.visibility.optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1)
  }).parse(req.query);
  const auth = req.auth!;
  const result = await runWithContext({ tenantId: auth.tenantId!, userId: auth.userId, rol: "admin" }, async (tx) => {
    const where = { tenantId: auth.tenantId!, kind: query.kind, visibility: query.visibility,
      ...(query.q ? { OR: [
        { title: { contains: query.q, mode: "insensitive" as const } },
        { contract: { property: { titulo: { contains: query.q, mode: "insensitive" as const } } } },
        { contract: { owner: { nombre: { contains: query.q, mode: "insensitive" as const } } } },
        { contract: { tenantPerson: { nombre: { contains: query.q, mode: "insensitive" as const } } } }
      ] } : {}) };
    const [data, total] = await Promise.all([
      tx.rentalDocument.findMany({ where, select: { ...select, contractId: true,
        contract: { select: { property: { select: { id: true, titulo: true } },
          owner: { select: { nombre: true } }, tenantPerson: { select: { nombre: true } } } }
      }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (query.page - 1) * 24, take: 24 }),
      tx.rentalDocument.count({ where })
    ]);
    return { data, meta: { total, page: query.page, limit: 24 } };
  });
  res.json(result);
});

rentalDocumentRoutes.get("/rental-contracts/:id/documents", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const auth = req.auth!;
  const data = await runWithContext({ tenantId: auth.tenantId!, userId: auth.userId, rol: "admin" }, async (tx) => {
    const contract = await tx.rentalContract.findUnique({ where: { id }, select: { id: true } });
    if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
    return tx.rentalDocument.findMany({ where: { contractId: id }, select, orderBy: { createdAt: "desc" } });
  });
  res.json({ data });
});

rentalDocumentRoutes.post("/rental-contracts/:id/documents", express.raw({ type: "application/pdf", limit: "10mb" }), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const info = metadata.parse(req.query);
  if (!Buffer.isBuffer(req.body)) throw new ApiError("VALIDATION_ERROR", "Subí un archivo PDF.");
  const auth = req.auth!;
  await runWithContext({ tenantId: auth.tenantId!, userId: auth.userId, rol: "admin" }, async (tx) => {
    const contract = await tx.rentalContract.findUnique({ where: { id }, select: { id: true } });
    if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
  });
  const key = newDocumentKey(auth.tenantId!, id);
  await saveRentalPdf(key, req.body);
  try {
    const document = await runWithContext({ tenantId: auth.tenantId!, userId: auth.userId, rol: "admin" },
      (tx) => tx.rentalDocument.create({ data: { tenantId: auth.tenantId!, contractId: id,
        uploadedById: auth.userId, storageKey: key, size: req.body.length, ...info }, select }));
    res.status(201).json({ document });
  } catch (error) {
    await deleteRentalPdf(key);
    throw error;
  }
});

rentalDocumentRoutes.get("/rental-documents/:id/content", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const auth = req.auth!;
  const document = await runWithContext({ tenantId: auth.tenantId!, userId: auth.userId, rol: "admin" },
    (tx) => tx.rentalDocument.findUnique({ where: { id }, select: { storageKey: true, mimeType: true } }));
  if (!document) throw new ApiError("NOT_FOUND", "El documento no existe.");
  const bytes = await readRentalPdf(document.storageKey);
  res.set({ "Content-Type": document.mimeType, "Content-Disposition": `${req.query.preview === "1" && document.mimeType.startsWith("image/") ? "inline" : "attachment"}; filename="archivo.${document.mimeType === "application/pdf" ? "pdf" : document.mimeType.split("/")[1]}"`,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).send(bytes);
});

rentalDocumentRoutes.delete("/rental-documents/:id", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const auth = req.auth!;
  const document = await runWithContext({ tenantId: auth.tenantId!, userId: auth.userId, rol: "admin" }, async (tx) => {
    const found = await tx.rentalDocument.findUnique({ where: { id } });
    if (!found) throw new ApiError("NOT_FOUND", "El documento no existe.");
    await tx.rentalDocument.delete({ where: { id } });
    return found;
  });
  await deleteRentalPdf(document.storageKey);
  res.json({ ok: true });
});
