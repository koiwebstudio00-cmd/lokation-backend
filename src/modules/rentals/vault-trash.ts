import {randomUUID} from 'node:crypto';
import {Prisma} from '@prisma/client';
import {type Tx} from '../../lib/prisma.js';
import {type AccessClaims} from '../../lib/tokens.js';
import {ApiError} from '../../lib/errors.js';

// Caller holds the tenant advisory lock, shared by uploads, moves and retention.
export async function trashVaultItems(tx:Tx,auth:AccessClaims,ids:string[],folderIds:string[],action:'trash'|'restore'){
 const folders=await tx.vaultFolder.findMany({where:{tenantId:auth.tenantId!}});
 const byId=new Map(folders.map(f=>[f.id,f]));
 if(folderIds.some(id=>!byId.has(id)))throw new ApiError('NOT_FOUND','Una carpeta no está disponible. No se aplicaron cambios.');
 const descendants=(root:string)=>folders.filter(f=>{let cursor:string|null=f.id;const seen=new Set<string>();while(cursor&&!seen.has(cursor)){if(cursor===root)return true;seen.add(cursor);cursor=byId.get(cursor)?.parentId??null;}return false;});
 const affectedFolders=[...new Set(folderIds.flatMap(id=>descendants(id).map(f=>f.id)))];
 const docs=await tx.rentalDocument.findMany({where:{OR:[{id:{in:ids}},{folderId:{in:affectedFolders}}]}});
 if(ids.some(id=>!docs.some(d=>d.id===id)))throw new ApiError('NOT_FOUND','Un archivo no está disponible. No se aplicaron cambios.');
 if(docs.length)await tx.$queryRaw(Prisma.sql`SELECT id FROM rental_documents WHERE id IN (${Prisma.join(docs.map(d=>Prisma.sql`${d.id}::uuid`))}) FOR UPDATE`);
 if(action==='trash'){
  // Different deletion batches remain independent, even inside a later trashed parent.
  const activeRoots=folderIds.filter(id=>!byId.get(id)!.deletedAt).filter(id=>{let parent=byId.get(id)!.parentId;while(parent){if(folderIds.includes(parent)&&!byId.get(parent)!.deletedAt)return false;parent=byId.get(parent)?.parentId??null;}return true;});
  for(const root of activeRoots){
   const batchId=randomUUID(),subtree=descendants(root).map(f=>f.id),now=new Date();
   await tx.vaultFolder.updateMany({where:{id:{in:subtree},deletedAt:null},data:{deletedAt:now,deletedById:auth.userId,trashBatchId:batchId}});
   await tx.rentalDocument.updateMany({where:{folderId:{in:subtree},deletedAt:null},data:{deletedAt:now,deletedById:auth.userId,trashBatchId:batchId}});
  }
  await tx.rentalDocument.updateMany({where:{id:{in:ids},deletedAt:null},data:{deletedAt:new Date(),deletedById:auth.userId,trashBatchId:null}});
  return;
 }
 const restoringFolders=new Set<string>(),restoringDocs=new Set(ids);
 for(const root of folderIds){
  const folder=byId.get(root)!;
  if(!folder.deletedAt)continue;
  const subtree=descendants(root),subtreeIds=new Set(subtree.map(f=>f.id));
  for(const f of subtree)if(f.trashBatchId===folder.trashBatchId&&f.deletedAt)restoringFolders.add(f.id);
  for(const d of docs)if(d.folderId&&subtreeIds.has(d.folderId)&&d.trashBatchId===folder.trashBatchId&&d.deletedAt)restoringDocs.add(d.id);
 }
 if([...restoringFolders].some(id=>byId.get(id)!.purgeStartedAt)||docs.some(d=>restoringDocs.has(d.id)&&d.purgeClaimedAt))throw new ApiError('CONFLICT','La eliminación definitiva del contenido ya comenzó. No se puede restaurar la carpeta parcialmente.');
 function checkParent(parent:string|null){const seen=new Set<string>();while(parent&&!seen.has(parent)){seen.add(parent);const f=byId.get(parent);if(!f||f.deletedAt&&!restoringFolders.has(parent))throw new ApiError('CONFLICT','Restaurá primero la carpeta superior o incluila en la misma selección.');if(f.purgeStartedAt)throw new ApiError('CONFLICT','La eliminación definitiva de la carpeta superior ya comenzó.');parent=f.parentId;}}
 for(const id of restoringFolders)checkParent(byId.get(id)!.parentId);
 for(const d of docs)if(restoringDocs.has(d.id))checkParent(d.folderId);
 await tx.vaultFolder.updateMany({where:{id:{in:[...restoringFolders]},deletedAt:{not:null}},data:{deletedAt:null,deletedById:null,trashBatchId:null}});
 await tx.rentalDocument.updateMany({where:{id:{in:[...restoringDocs]},deletedAt:{not:null}},data:{deletedAt:null,deletedById:null,trashBatchId:null}});
}
