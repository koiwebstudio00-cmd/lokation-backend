import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { runWithContext, type Tx } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
import type { AccessClaims } from "../../lib/tokens.js";

const id = z.string().uuid();
export const accessSchema = z.object({
  accessMode: z.enum(["admin", "inherit", "team", "selected"]),
  teamPermission: z.enum(["read", "edit"]).default("read"),
  grants: z.array(z.object({ userId: id, permission: z.enum(["read", "edit"]) }).strict()).max(200).default([])
});
export async function validateAccess(tx: Tx, auth: AccessClaims, access: z.infer<typeof accessSchema>, parent: string | null) {
  if (access.accessMode === "inherit" && !parent) throw new ApiError("VALIDATION_ERROR", "Para heredar permisos elegí una carpeta.");
  const ids = [...new Set(access.grants.map(g => g.userId))];
  if (access.accessMode === "selected" && !ids.length) throw new ApiError("VALIDATION_ERROR", "Seleccioná al menos un usuario.");
  if (ids.length && await tx.user.count({ where: { id: { in: ids }, tenantId: auth.tenantId, estado: "activo" } }) !== ids.length) throw new ApiError("VALIDATION_ERROR", "Solo podés compartir con usuarios activos de tu inmobiliaria.");
}
export async function folderPermission(tx: Tx, folder: string | null, edit = false) {
  const [r] = await tx.$queryRaw<{ allowed: boolean }[]>`SELECT vault_folder_allows(${folder}::uuid, ${edit}) AS allowed`;
  return r?.allowed ?? false;
}
export async function requireFolder(tx: Tx, folder: string | null, edit = false) {
  if (!await folderPermission(tx, folder, edit)) throw new ApiError("FORBIDDEN", "No tenés acceso a esta carpeta.");
}
export async function documentCanEdit(tx: Tx, doc: {folderId: string | null; accessMode: string; teamPermission: string; grants: unknown;uploadedById?:string}) {
  const [context] = await tx.$queryRaw<{role:string;userId:string}[]>`SELECT ctx_rol() AS role, ctx_user_id()::text AS "userId"`;
  if(context?.role === "community") return doc.uploadedById === context.userId && (!doc.folderId || await folderPermission(tx,doc.folderId));
  const [r] = await tx.$queryRaw<{allowed:boolean}[]>`SELECT vault_document_allows(${doc.folderId}::uuid, ${doc.accessMode}, ${doc.teamPermission}, ${JSON.stringify(doc.grants)}::jsonb, true) AS allowed`;
  return r?.allowed ?? false;
}
export async function lockVault(tx: Tx, auth: AccessClaims) {
  // Serialize structural changes per tenant so two concurrent moves cannot form a cycle.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${auth.tenantId!}))`;
}
const folderSelect = {deletedAt:true,trashBatchId:true,purgeStartedAt:true,createdAt:true,updatedAt:true,id:true,parentId:true,name:true,accessMode:true,teamPermission:true,grants:true} as const;
export const vaultRoutes = Router();
vaultRoutes.use("/vault-folders", requireAuth, requireRole("admin", "agente", "community"));
vaultRoutes.get("/vault-folders", async (req,res) => {
  const state=z.enum(["active","trash","all"]).default("active").parse(req.query.state);
  if(state!=="active"&&req.auth!.rol!=="admin")throw new ApiError("FORBIDDEN","Solo administradores pueden acceder a la papelera.");
  const result = await runWithContext(req.auth!, async tx => {
    const folders = await tx.vaultFolder.findMany({where:{tenantId:req.auth!.tenantId,...(state==="all"?{}:{deletedAt:state==="trash"?{not:null}:null}),purgeStartedAt:null},select:folderSelect,orderBy:{name:"asc"}});
    return Promise.all(folders.map(async f=>({...f,canEdit:await folderPermission(tx,f.id,true),grants:req.auth!.rol==="admin"?f.grants:[]})));
  });
  res.json({data:result,asOf:new Date().toISOString()});
});
vaultRoutes.post("/vault-folders", async(req,res)=>{
  if(req.auth!.rol === "community") throw new ApiError("FORBIDDEN","Community solo puede consultar carpetas compartidas.");
  const input=z.object({name:z.string().trim().min(1).max(160),parentId:id.nullable().default(null)}).strict().parse(req.body);
  const folder=await runWithContext(req.auth!,async tx=>{
    await lockVault(tx,req.auth!); await requireFolder(tx,input.parentId,true);
    return tx.vaultFolder.create({data:{...input,tenantId:req.auth!.tenantId!,accessMode:input.parentId?"inherit":"admin"},select:folderSelect});
  });
  res.status(201).json({folder});
});
vaultRoutes.patch("/vault-folders/:id",async(req,res)=>{
  const folderId=id.parse(req.params.id);
  const input=z.object({name:z.string().trim().min(1).max(160).optional(),parentId:id.nullable().optional(),access:accessSchema.optional(),confirmAccessChange:z.boolean().optional()}).strict().parse(req.body);
  const folder=await runWithContext(req.auth!,async tx=>{
    await lockVault(tx,req.auth!);
    const existing=await tx.vaultFolder.findUnique({where:{id:folderId}});
    if(!existing) throw new ApiError("NOT_FOUND","La carpeta no existe.");
    await requireFolder(tx,folderId,true);
    if(input.access && req.auth!.rol!=="admin") throw new ApiError("FORBIDDEN","Solo administradores pueden compartir.");
    const parent=input.parentId===undefined?existing.parentId:input.parentId;
    if(parent!==existing.parentId){
      if(req.auth!.rol!=="admin") throw new ApiError("FORBIDDEN","Solo administradores pueden mover carpetas y cambiar su acceso heredado.");
      if(!input.confirmAccessChange) throw new ApiError("VALIDATION_ERROR","Confirmá el cambio de permisos al mover.");
      await requireFolder(tx,parent,true);
      let cursor=parent; const seen=new Set<string>([folderId]);
      while(cursor){
        if(seen.has(cursor)||seen.size>=100) throw new ApiError("VALIDATION_ERROR","No podés mover una carpeta dentro de sí misma o sus subcarpetas.");
        seen.add(cursor); const node=await tx.vaultFolder.findUnique({where:{id:cursor},select:{parentId:true}});
        if(!node) throw new ApiError("NOT_FOUND","La carpeta destino no existe."); cursor=node.parentId;
      }
    }
    await validateAccess(tx,req.auth!,input.access??accessSchema.parse(existing),parent);
    return tx.vaultFolder.update({where:{id:folderId},data:{name:input.name,parentId:parent,...input.access},select:folderSelect});
  }); res.json({folder});
});

vaultRoutes.get("/vault-activity",requireAuth,requireRole("admin"),async(req,res)=>{
 const q=z.object({entityId:id.optional(),action:z.enum(["created","uploaded","renamed","moved","access_changed","trashed","restored","purged"]).optional(),page:z.coerce.number().int().min(1).max(100000).default(1)}).parse(req.query);
 const result=await runWithContext(req.auth!,async tx=>{
  const where={tenantId:req.auth!.tenantId!,entityId:q.entityId,action:q.action};
  const [data,total]=await Promise.all([tx.vaultActivity.findMany({where,orderBy:[{createdAt:"desc"},{id:"desc"}],take:25,skip:(q.page-1)*25}),tx.vaultActivity.count({where})]);
  return {data,meta:{total,page:q.page,limit:25}};
 });res.json(result);
});
