import {trashVaultItems} from "./vault-trash.js";
import { Prisma } from "@prisma/client";
import { accessSchema, validateAccess, requireFolder, documentCanEdit, lockVault } from "./vault.js";
import { sealTransfer } from "../../lib/file-transfer-tickets.js";
import { ACCESS_COOKIE } from "../../lib/cookies.js";
import express, { Router } from "express";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { runWithContext } from "../../lib/prisma.js";
import { detectPrivateFile, savePrivateFile, deleteRentalPdf, newDocumentKey, readRentalPdf, saveRentalPdf } from "../../lib/rental-documents-storage.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";

export const rentalDocumentRoutes = Router();
rentalDocumentRoutes.use("/rental-contracts", requireAuth, requireRole("admin"));
rentalDocumentRoutes.use("/rental-documents", requireAuth, requireRole("admin", "agente", "community"));
const uuid = z.string().uuid();
const metadata = z.object({ title: z.string().trim().min(3).max(160),
  kind: z.enum(["contrato", "comprobante", "inventario", "otro"]),
  visibility: z.enum(["interna", "inquilino", "propietario", "ambos"]) });
const select = { uploadedById:true, deletedAt:true, deletedById:true, updatedAt: true, folderId: true, accessMode: true, teamPermission: true, grants: true, personId: true, dossierKind: true, person: { select: { id: true, nombre: true } }, id: true, title: true, kind: true, visibility: true, size: true, mimeType: true, originalName: true, createdAt: true } as const;

const uploadTicketSchema = z.object({
  folderId: uuid.optional(),
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
    if (req.auth!.rol !== "admin" && (info.mode === "contract" || info.contractId)) throw new ApiError("FORBIDDEN", "Solo administradores pueden vincular documentos a contratos.");
    await requireFolder(tx, info.folderId ?? null, true);
    if (!info.contractId) return;
    const contract = await tx.rentalContract.findUnique({where:{id:info.contractId}});
    if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
    if (info.personId && info.personId !== contract.tenantPersonId && !await tx.rentalGuarantor.findUnique({where:{contractId_personId:{contractId:info.contractId,personId:info.personId}}})) throw new ApiError("VALIDATION_ERROR", "La persona no pertenece al legajo.");
  });
  const query = new URLSearchParams({title:info.title,kind:info.kind});
  if(info.folderId) query.set("folderId",info.folderId);
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
  const document = await runWithContext(req.auth!, tx=>tx.rentalDocument.findUnique({where:{id,deletedAt:null},select:{id:true}}));
  if(!document) throw new ApiError("NOT_FOUND", "El documento no existe.");
  res.set("Cache-Control","no-store").json(sealTransfer({operation:"download",path:`/rental-documents/${id}/content${req.query.preview === "1" ? "?preview=1" : ""}`,credential:req.cookies[ACCESS_COOKIE],portal:false}));
});

// The vault uses the same tenant/RLS boundary and private download endpoint as contracts.
rentalDocumentRoutes.post("/rental-documents", express.raw({ type: "application/octet-stream", limit: "10mb" }), async (req, res) => {
  const info = z.object({ title: metadata.shape.title, kind: metadata.shape.kind,
    folderId: uuid.optional(), originalName: z.string().trim().min(1).max(255), contractId: uuid.optional(), personId: uuid.optional(),
    dossierKind: z.enum(["identidad", "ingresos", "garantia", "otro"]).optional() }).superRefine((v,ctx) => {
      if ((v.contractId || v.personId || v.dossierKind) && !(v.contractId && v.personId && v.dossierKind)) ctx.addIssue({code: "custom", message: "Indicá contrato, persona y tipo de legajo."});
    }).parse(req.query);
  if (!Buffer.isBuffer(req.body)) throw new ApiError("VALIDATION_ERROR", "Seleccioná un archivo.");
  const type = detectPrivateFile(req.body);
  const auth = req.auth!;
  const key = newDocumentKey(auth.tenantId!, auth.userId).replace(/pdf$/, type.extension);
  await savePrivateFile(key, req.body);
  try {
    const document = await runWithContext(auth,
      async tx => {
        await lockVault(tx,auth);
        await requireFolder(tx, info.folderId ?? null, true);
        if (auth.rol !== "admin" && info.contractId) throw new ApiError("FORBIDDEN", "Solo administradores pueden vincular documentos.");
        if (info.contractId) {
          await tx.$queryRaw`SELECT id FROM rental_contracts WHERE id = ${info.contractId}::uuid FOR UPDATE`;
          const contract = await tx.rentalContract.findUnique({ where: { id: info.contractId } });
          if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
          const guarantor = await tx.rentalGuarantor.findUnique({ where: { contractId_personId: { contractId: info.contractId, personId: info.personId! } } });
          if (contract.tenantPersonId !== info.personId && !guarantor) throw new ApiError("VALIDATION_ERROR", "La persona no es inquilino ni garante de este contrato.");
        }
        return tx.rentalDocument.create({ data: { ...info, tenantId: auth.tenantId!, uploadedById: auth.userId,
          accessMode: info.folderId ? "inherit" : "admin", visibility: "interna", mimeType: type.mime, storageKey: key, size: req.body.length }, select });
      });
    res.status(201).json({ document });
  } catch (error) { await deleteRentalPdf(key); throw error; }
});

rentalDocumentRoutes.get("/rental-documents", async (req, res) => {
  const query = z.object({
    state: z.enum(["active","trash"]).default("active"),
    sort: z.enum(["name","modified","size"]).default("modified"),
    direction: z.enum(["asc","desc"]).default("desc"),
    accessMode: z.enum(["admin","inherit","team","selected"]).optional(),
    modified: z.enum(["day","week","month"]).optional(),
    folderId: z.union([uuid,z.literal("root")]).optional(),
    q: z.string().trim().max(160).optional(),
    kind: metadata.shape.kind.optional(),
    visibility: metadata.shape.visibility.optional(),
    personId: uuid.optional(), contractId: uuid.optional(),
    dossierKind: z.enum(["identidad", "ingresos", "garantia", "otro"]).optional(),
    limit: z.coerce.number().int().min(1).max(24).default(24),
    page: z.coerce.number().int().min(1).max(100000).default(1)
  }).parse(req.query);
  const auth = req.auth!;
  const result = await runWithContext(auth, async (tx) => {
    if(query.folderId && query.folderId!=="root") await requireFolder(tx,query.folderId);
    if(query.state==="trash" && auth.rol!=="admin") throw new ApiError("FORBIDDEN","Solo administradores pueden acceder a la papelera.");
    const days = query.modified === "day" ? 1 : query.modified === "week" ? 7 : 30;
    const where = { purgeClaimedAt:null, deletedAt:query.state==="trash"?{not:null}:null, accessMode: query.accessMode, ...(query.modified ? {updatedAt:{gte:new Date(Date.now()-days*86400000)}} : {}), folderId: query.folderId === "root" ? null : query.folderId, tenantId: auth.tenantId!, personId: query.personId, contractId: query.contractId, dossierKind: query.dossierKind, kind: query.kind, visibility: query.visibility,
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
      }, orderBy: [{ [query.sort === "name" ? "title" : query.sort === "size" ? "size" : "updatedAt"]: query.direction }, { id: "asc" }], skip: (query.page - 1) * query.limit, take: query.limit }),
      tx.rentalDocument.count({ where })
    ]);
    return { data: await Promise.all(data.map(async d=>({...d,canEdit:await documentCanEdit(tx,d),grants:auth.rol==="admin"?d.grants:[]}))), meta: { total, page: query.page, limit: query.limit } };
  });
  res.json(result);
});

rentalDocumentRoutes.get("/rental-contracts/:id/documents", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const auth = req.auth!;
  const data = await runWithContext(auth, async (tx) => {
    const contract = await tx.rentalContract.findUnique({ where: { id }, select: { id: true } });
    if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
    return tx.rentalDocument.findMany({ where: { contractId: id, deletedAt:null }, select, orderBy: { createdAt: "desc" } });
  });
  res.json({ data });
});

rentalDocumentRoutes.post("/rental-contracts/:id/documents", express.raw({ type: "application/pdf", limit: "10mb" }), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const info = metadata.parse(req.query);
  if (!Buffer.isBuffer(req.body)) throw new ApiError("VALIDATION_ERROR", "Subí un archivo PDF.");
  const auth = req.auth!;
  await runWithContext(auth, async (tx) => {
    const contract = await tx.rentalContract.findUnique({ where: { id }, select: { id: true } });
    if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
  });
  const key = newDocumentKey(auth.tenantId!, id);
  await saveRentalPdf(key, req.body);
  try {
    const document = await runWithContext(auth,
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
  const document = await runWithContext(auth,
    (tx) => tx.rentalDocument.findUnique({ where: { id, deletedAt:null }, select: { storageKey: true, mimeType: true } }));
  if (!document) throw new ApiError("NOT_FOUND", "El documento no existe.");
  const bytes = await readRentalPdf(document.storageKey);
  res.set({ "Content-Type": document.mimeType, "Content-Disposition": `${req.query.preview === "1" && document.mimeType.startsWith("image/") ? "inline" : "attachment"}; filename="archivo.${document.mimeType === "application/pdf" ? "pdf" : document.mimeType.split("/")[1]}"`,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).send(bytes);
});

rentalDocumentRoutes.delete("/rental-documents/:id", requireRole("admin"), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const auth = req.auth!;
  await runWithContext(auth, async (tx) => {
    await lockVault(tx,auth);
    await trashVaultItems(tx,auth,[id],[],"trash");
  });
  res.json({ ok: true });
});

rentalDocumentRoutes.patch("/rental-documents/:id", async(req,res)=>{
  const id=uuid.parse(req.params.id);
  const input=z.object({title:metadata.shape.title.optional(),folderId:uuid.nullable().optional(),access:accessSchema.optional(),confirmAccessChange:z.boolean().optional()}).strict().parse(req.body);
  const document=await runWithContext(req.auth!,async tx=>{
    await lockVault(tx,req.auth!);
    const current=await tx.rentalDocument.findUnique({where:{id,deletedAt:null}});
    if(!current) throw new ApiError("NOT_FOUND","El documento no existe.");
    if(!await documentCanEdit(tx,current)) throw new ApiError("FORBIDDEN","Solo tenés permiso de lectura.");
    if(input.access && req.auth!.rol!=="admin") throw new ApiError("FORBIDDEN","Solo administradores pueden compartir.");
    const folder=input.folderId===undefined?current.folderId:input.folderId;
    if(folder!==current.folderId){
      if(req.auth!.rol!=="admin") throw new ApiError("FORBIDDEN","Solo administradores pueden mover archivos y cambiar su acceso heredado.");
      if(!input.confirmAccessChange) throw new ApiError("VALIDATION_ERROR","Confirmá el cambio de permisos al mover.");
      await requireFolder(tx,folder,true);
    }
    await validateAccess(tx,req.auth!,input.access??accessSchema.parse(current),folder);
    return tx.rentalDocument.update({where:{id},data:{title:input.title,folderId:folder,...input.access},select});
  }); res.json({document});
});

rentalDocumentRoutes.post("/rental-documents/batch",requireRole("admin"),async(req,res)=>{
 const input=z.object({ids:z.array(uuid).max(100),folderIds:z.array(uuid).max(100).default([]),action:z.enum(["trash","restore","move"]),folderId:uuid.nullable().optional(),confirmAccessChange:z.boolean().optional()}).strict().parse(req.body);
 const ids=[...new Set(input.ids)],folderIds=[...new Set(input.folderIds)];
 if(!ids.length&&!folderIds.length||ids.length+folderIds.length>100)throw new ApiError("VALIDATION_ERROR","Seleccioná entre 1 y 100 elementos.");

 await runWithContext(req.auth!,async tx=>{
  await lockVault(tx,req.auth!);
  if(input.action!=="move")return trashVaultItems(tx,req.auth!,ids,folderIds,input.action);
  if(ids.length)await tx.$queryRaw(Prisma.sql`SELECT id FROM rental_documents WHERE id IN (${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}) FOR UPDATE`);
  const docs=await tx.rentalDocument.findMany({where:{id:{in:ids}}});
  if(docs.some(d=>d.purgeClaimedAt))throw new ApiError("CONFLICT","La eliminación definitiva ya comenzó.");
  const movingFolders=await tx.vaultFolder.findMany({where:{id:{in:folderIds}}});
  if(movingFolders.some(f=>f.deletedAt))throw new ApiError("CONFLICT","Restaurá las carpetas antes de moverlas.");
  if(movingFolders.length!==folderIds.length)throw new ApiError("NOT_FOUND","Una carpeta no está disponible.");
  if(docs.length!==ids.length)throw new ApiError("NOT_FOUND","Uno o más archivos no están disponibles. No se aplicaron cambios.");
  if(input.action==="move"){
   if(input.folderId===undefined||!input.confirmAccessChange)throw new ApiError("VALIDATION_ERROR","Elegí destino y confirmá el cambio de permisos heredados.");
   await requireFolder(tx,input.folderId,true);
   const allFolders=folderIds.length?await tx.vaultFolder.findMany({}):[];
   const byId=new Map(allFolders.map(f=>[f.id,f]));
   const underSelectedFolder=(parent:string|null)=>{while(parent){if(folderIds.includes(parent))return true;parent=byId.get(parent)?.parentId??null;}return false;};
   for(const folder of movingFolders){
    if(folder.accessMode==="inherit"&&!input.folderId&&!underSelectedFolder(folder.parentId))throw new ApiError("VALIDATION_ERROR","Las carpetas con herencia deben permanecer dentro de otra carpeta.");
    let cursor=input.folderId;const seen=new Set<string>([folder.id]);
    while(cursor){if(seen.has(cursor))throw new ApiError("VALIDATION_ERROR","No podés mover una carpeta dentro de sí misma o sus descendientes.");seen.add(cursor);cursor=byId.get(cursor)?.parentId??null;}
   }
   // If ancestor and descendant are both selected, move only the ancestor.
   const roots=movingFolders.filter(f=>!underSelectedFolder(f.parentId));
   for(const folder of roots)await tx.vaultFolder.update({where:{id:folder.id},data:{parentId:input.folderId}});


   const independentDocs=docs.filter(d=>!underSelectedFolder(d.folderId));
   for(const doc of docs)if(doc.deletedAt)throw new ApiError("CONFLICT","Restaurá los archivos antes de moverlos.");
   for(const doc of independentDocs){
    if(doc.deletedAt)throw new ApiError("CONFLICT","Restaurá los archivos antes de moverlos.");
    if(doc.accessMode==="inherit"&&!input.folderId)throw new ApiError("VALIDATION_ERROR","Los archivos con permisos heredados deben permanecer en una carpeta. Cambiá su acceso individual antes de moverlos a Mi unidad.");
   }
   await tx.rentalDocument.updateMany({where:{id:{in:independentDocs.map(d=>d.id)}},data:{folderId:input.folderId}});
  }
 });
 res.json({ok:true,count:ids.length+folderIds.length});
});
