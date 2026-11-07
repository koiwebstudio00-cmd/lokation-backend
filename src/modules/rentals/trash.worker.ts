import {runWithContext} from '../../lib/prisma.js';
import {deleteRentalPdf} from '../../lib/rental-documents-storage.js';

type Claim={id:string;tenant_id:string;storage_key:string};
export async function purgeExpiredVaultFiles(removeFile=deleteRentalPdf){
 const claimed=await runWithContext({rol:'worker'},tx=>tx.$queryRaw<Claim[]>`SELECT * FROM vault_claim_expired()`);
 let removed=0;
 for(const file of claimed){
  try {
   if(!file.storage_key.startsWith(`${file.tenant_id}/rental-documents/`)||! /^[0-9a-f-]{36}\/rental-documents\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|jpg|png|webp)$/.test(file.storage_key))throw new Error('Invalid storage key');
   await removeFile(file.storage_key);
   await runWithContext({rol:'worker'},tx=>tx.$executeRaw`SELECT vault_finish_purge(${file.id}::uuid)`);
   removed++;
  }catch{console.error('[vault-trash] purge failed; retry scheduled',file.id);}
 }
 const [result]=await runWithContext({rol:"worker"},tx=>tx.$queryRaw<{removed:number}[]>`SELECT vault_purge_empty_folders() AS removed`);
 return {claimed:claimed.length,removed,foldersRemoved:result?.removed??0};
}
let timer:NodeJS.Timeout|null=null;
let running=false;
export function startVaultTrashWorker(){
 if(timer)return;
 const tick=async()=>{if(running)return;running=true;try{await purgeExpiredVaultFiles();}catch{console.error('[vault-trash] worker unavailable; retry scheduled');}finally{running=false;}};
 timer=setInterval(()=>{void tick();},60_000);timer.unref();void tick();
}
export function stopVaultTrashWorker(){if(timer)clearInterval(timer);timer=null;}
