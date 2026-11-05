import { sealTransfer } from "../../lib/file-transfer-tickets.js";
import { ACCESS_COOKIE } from "../../lib/cookies.js";
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
const select = { personId: true, dossierKind: true, person: { select: { id: true, nombre: true } }, id: true, title: true, kind: true, visibility: true, size: true, mimeType: true, originalName: true, createdAt: true } as const;

const uploadTicketSchema = z.object({
  mode: z.enum(["vault", "contract"]), title: metadata.shape.title, kind: metadata.shape.kind,
  visibility: metadata.shape.visibility.default("interna"), originalName: z.string().trim().min(1).max(255),
  contractId: uuid.optional(), personId: uuid.optional(), dossierKind: z.enum(["identidad","ingresos","garantia","otro"]).optional(),
  size: z.number().int().min(8).max(10 * 1024 * 1024)
}).strict();
rentalDocumentRoutes.post("/rental-documents/upload-ticket", async (req,res) => {
  const info = uploadTicketSchema.parse(req.body);
  if (info.mode === "contract" && (!info.contractId || info.personId || info.dossierKind)) throw new ApiError("VALIDATION_ERROR", "Contrato inválido.");
  if (info.mode === "vault" && (info.contractId || info.personId || info.dossierKind) && !(info.contractId && info.personId && info.dossierKind)) throw new ApiError("VALIDATION_ERROR", "Legajo incompleto.");
  await runWithContext(req.auth!, async tx => {
    if (!info.contractId) return;
    const contract = await tx.rentalContract.findUnique({where:{id:info.contractId}});
    if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
    if (info.personId && info.personId !== contract.tenantPersonId && !await tx.rentalGuarantor.findUnique({where:{contractId_personId:{contractId:info.contractId,personId:info.personId}}})) throw new ApiError("VALIDATION_ERROR", "La persona no pertenece al legajo.");
  });
  const query = new URLSearchParams({title:info.title,kind:info.kind});
  if(info.mode === "contract") query.set("visibility",info.visibility);
  else {
    query.set("originalName",info.originalName);
    if(info.contractId) { query.set("contractId",info.contractId); query.set("personId",info.personId!); query.set("dossierKind",info.dossierKind!); }
  }
  const path = info.mode === "contract" ? `/rental-contracts/${info.contractId}/documents` : "/rental-documents";
  res.set("Cache-Control","no-store").json(sealTransfer({operation:"upload",path:`${path}?${query}`,credential:req.cookies[ACCESS_COOKIE],portal:false,size:info.size}));
});
rentalDocumentRoutes.get("/rental-documents/:id/download-ticket", async (req,res) => {
  const id = uuid.parse(req.params.id);
  const document = await runWithContext(req.auth!, tx=>tx.rentalDocument.findUnique({where:{id},select:{id:true}}));
  if(!document) throw new ApiError("NOT_FOUND", "El documento no existe.");
  res.set("Cache-Control","no-store").json(sealTransfer({operation:"download",path:`/rental-documents/${id}/content${req.query.preview === "1" ? "?preview=1" : ""}`,credential:req.cookies[ACCESS_COOKIE],portal:false}));
});

// The vault uses the same tenant/RLS boundary and private download endpoint as contracts.
rentalDocumentRoutes.post("/rental-documents", express.raw({ type: "application/octet-stream", limit: "10mb" }), async (req, res) => {
  const info = z.object({ title: metadata.shape.title, kind: metadata.shape.kind,
    originalName: z.string().trim().min(1).max(255), contractId: uuid.optional(), personId: uuid.optional(),
    dossierKind: z.enum(["identidad", "ingresos", "garantia", "otro"]).optional() }).superRefine((v,ctx) => {
      if ((v.contractId || v.personId || v.dossierKind) && !(v.contractId && v.personId && v.dossierKind)) ctx.addIssue({code: "custom", message: "Indicá contrato, persona y tipo de legajo."});
    }).parse(req.query);
  if (!Buffer.isBuffer(req.body)) throw new ApiError("VALIDATION_ERROR", "Seleccioná un archivo.");
  const type = detectPrivateFile(req.body);
  const auth = req.auth!;
  const key = newDocumentKey(auth.tenantId!, auth.userId).replace(/pdf$/, type.extension);
  await savePrivateFile(key, req.body);
  try {
    const document = await runWithContext({ tenantId: auth.tenantId!, userId: auth.userId, rol: "admin" },
      async tx => {
        if (info.contractId) {
          await tx.$queryRaw`SELECT id FROM rental_contracts WHERE id = ${info.contractId}::uuid FOR UPDATE`;
          const contract = await tx.rentalContract.findUnique({ where: { id: info.contractId } });
          if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
          const guarantor = await tx.rentalGuarantor.findUnique({ where: { contractId_personId: { contractId: info.contractId, personId: info.personId! } } });
          if (contract.tenantPersonId !== info.personId && !guarantor) throw new ApiError("VALIDATION_ERROR", "La persona no es inquilino ni garante de este contrato.");
        }
        return tx.rentalDocument.create({ data: { ...info, tenantId: auth.tenantId!, uploadedById: auth.userId,
          visibility: "interna", mimeType: type.mime, storageKey: key, size: req.body.length }, select });
      });
    res.status(201).json({ document });
  } catch (error) { await deleteRentalPdf(key); throw error; }
});

rentalDocumentRoutes.get("/rental-documents", async (req, res) => {
  const query = z.object({
    q: z.string().trim().max(160).optional(),
    kind: metadata.shape.kind.optional(),
    visibility: metadata.shape.visibility.optional(),
    personId: uuid.optional(), contractId: uuid.optional(),
    dossierKind: z.enum(["identidad", "ingresos", "garantia", "otro"]).optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1)
  }).parse(req.query);
  const auth = req.auth!;
  const result = await runWithContext({ tenantId: auth.tenantId!, userId: auth.userId, rol: "admin" }, async (tx) => {
    const where = { tenantId: auth.tenantId!, personId: query.personId, contractId: query.contractId, dossierKind: query.dossierKind, kind: query.kind, visibility: query.visibility,
      ...(query.q ? { OR: [
        { title: { contains: query.q, mode: "insensitive" as const } },
        { person: { nombre: { contains: query.q, mode: "insensitive" as const } } },
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
