import express, { Router } from "express";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { runWithContext } from "../../lib/prisma.js";
import { deleteRentalPdf, newDocumentKey, readRentalPdf, saveRentalPdf } from "../../lib/rental-documents-storage.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";

export const rentalDocumentRoutes = Router();
rentalDocumentRoutes.use(["/rental-contracts", "/rental-documents"], requireAuth, requireRole("admin"));
const uuid = z.string().uuid();
const metadata = z.object({ title: z.string().trim().min(3).max(160),
  kind: z.enum(["contrato", "comprobante", "inventario", "otro"]),
  visibility: z.enum(["interna", "inquilino", "propietario", "ambos"]) });
const select = { id: true, title: true, kind: true, visibility: true, size: true, createdAt: true } as const;

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
    (tx) => tx.rentalDocument.findUnique({ where: { id }, select: { storageKey: true } }));
  if (!document) throw new ApiError("NOT_FOUND", "El documento no existe.");
  const bytes = await readRentalPdf(document.storageKey);
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=\"documento.pdf\"",
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
