import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {beforeAll,describe,expect,it,vi} from 'vitest';
import {buildApp} from '../src/app.js';
import {runWithContext} from '../src/lib/prisma.js';
import {newDocumentKey,saveRentalPdf,readRentalPdf,deleteRentalPdf} from '../src/lib/rental-documents-storage.js';
import {purgeExpiredVaultFiles} from '../src/modules/rentals/trash.worker.js';
import {adminDb,DB_AVAILABLE,seedTenantWithUsers,TEST_PASSWORD,truncateAll} from './helpers.js';
describe.runIf(DB_AVAILABLE)('Vault retention',()=>{
 const app=buildApp(),admin=request.agent(app);let a:Awaited<ReturnType<typeof seedTenantWithUsers>>,b:typeof a,csrf:string;
 const pdf=Buffer.from('%PDF-1.4\nRetention fixture\n%%EOF\n');
 beforeAll(async()=>{await truncateAll();a=await seedTenantWithUsers('retention-a');b=await seedTenantWithUsers('retention-b');csrf=(await admin.post('/v1/auth/login').send({email:a.admin.email,password:TEST_PASSWORD})).body.csrf_token;});
 async function doc(seed:typeof a,days:number|null,claimed=false){const key=newDocumentKey(seed.tenant.id,randomUUID());await saveRentalPdf(key,pdf);return adminDb().rentalDocument.create({data:{tenantId:seed.tenant.id,uploadedById:seed.admin.id,title:'Retention QA',kind:'otro',visibility:'interna',storageKey:key,size:pdf.length,deletedAt:days===null?null:new Date(Date.now()-days*86400000),purgeClaimedAt:claimed?new Date(Date.now()-6*60000):null}});}
 it('deletes only expired files across tenants and retains active/recent files',async()=>{
  const expired=await doc(a,31),other=await doc(b,31),recent=await doc(a,29),active=await doc(b,null);
  const result=await purgeExpiredVaultFiles();expect(result.removed).toBe(2);
  for(const d of [expired,other]){expect(await adminDb().rentalDocument.findUnique({where:{id:d.id}})).toBeNull();await expect(readRentalPdf(d.storageKey)).rejects.toThrow();}
  for(const d of [recent,active])expect(await readRentalPdf(d.storageKey)).toEqual(pdf);
 });
 it('restoration before claiming keeps the file; restoration during deletion is blocked',async()=>{
  const restored=await doc(a,31);
  await admin.post('/v1/rental-documents/batch').set('x-csrf-token',csrf).send({ids:[restored.id],action:'restore'}).expect(200);
  expect((await purgeExpiredVaultFiles()).removed).toBe(0);expect(await readRentalPdf(restored.storageKey)).toEqual(pdf);
  const claimed=await doc(a,31);
  const remove=vi.fn(async()=>{await admin.post('/v1/rental-documents/batch').set('x-csrf-token',csrf).send({ids:[claimed.id],action:'restore'}).expect(409);throw new Error('storage unavailable');});
  expect((await purgeExpiredVaultFiles(remove)).removed).toBe(0);
  expect((await adminDb().rentalDocument.findUniqueOrThrow({where:{id:claimed.id}})).purgeClaimedAt).not.toBeNull();
  expect(await readRentalPdf(claimed.storageKey)).toEqual(pdf);
  expect((await purgeExpiredVaultFiles(remove)).claimed).toBe(0);
  await adminDb().$transaction(async tx=>{await tx.$executeRaw`SELECT set_config('app.rol','worker',true)`;await tx.rentalDocument.update({where:{id:claimed.id},data:{purgeClaimedAt:new Date(Date.now()-6*60000)}});});
  expect((await purgeExpiredVaultFiles()).removed).toBe(1);
  expect(await adminDb().rentalDocument.findUnique({where:{id:claimed.id}})).toBeNull();

 });
 it('retries abandoned claims; completion is idempotent and only worker may claim',async()=>{
  const retry=await doc(b,32,true);
  await deleteRentalPdf(retry.storageKey);
  expect((await purgeExpiredVaultFiles()).removed).toBe(1);
  expect(await adminDb().rentalDocument.findUnique({where:{id:retry.id}})).toBeNull();
  await runWithContext({rol:'worker'},tx=>tx.$executeRaw`SELECT vault_finish_purge(${retry.id}::uuid)`);
  await expect(runWithContext({rol:'admin',tenantId:a.tenant.id,userId:a.admin.id},tx=>tx.$queryRaw`SELECT * FROM vault_claim_expired()`)).rejects.toThrow();
 });
 it('concurrent workers do not claim the same row',async()=>{
  const file=await doc(a,31);const calls:string[]=[];
  await Promise.all([purgeExpiredVaultFiles(async key=>{calls.push(key);await deleteRentalPdf(key);}),purgeExpiredVaultFiles(async key=>{calls.push(key);await deleteRentalPdf(key);})]);
  expect(calls.filter(key=>key===file.storageKey)).toHaveLength(1);
 });
 it('purges expired folder trees and blocks partial restoration when deletion starts',async()=>{
  const root=(await admin.post('/v1/vault-folders').set('x-csrf-token',csrf).send({name:'Expired root'}).expect(201)).body.folder.id;
  const child=(await admin.post('/v1/vault-folders').set('x-csrf-token',csrf).send({name:'Expired child',parentId:root}).expect(201)).body.folder.id;
  const file=(await admin.post('/v1/rental-documents').set('x-csrf-token',csrf).query({title:'Nested retention',kind:'otro',originalName:'qa.pdf',folderId:child}).set('Content-Type','application/octet-stream').send(pdf).expect(201)).body.document;
  await admin.post('/v1/rental-documents/batch').set('x-csrf-token',csrf).send({ids:[],folderIds:[root],action:'trash'}).expect(200);
  const old=new Date(Date.now()-31*86400000);
  await adminDb().vaultFolder.updateMany({where:{id:{in:[root,child]}},data:{deletedAt:old}});
  await adminDb().rentalDocument.update({where:{id:file.id},data:{deletedAt:old}});
  const result=await purgeExpiredVaultFiles(async key=>{
   await admin.post('/v1/rental-documents/batch').set('x-csrf-token',csrf).send({ids:[],folderIds:[root],action:'restore'}).expect(409);
   await deleteRentalPdf(key);
  });
  expect(result.removed).toBe(1);expect(result.foldersRemoved).toBe(1);
  await purgeExpiredVaultFiles();
  expect(await adminDb().vaultFolder.count({where:{id:{in:[root,child]}}})).toBe(0);
  const events=(await admin.get('/v1/vault-activity').query({entityId:root}).expect(200)).body.data;
  expect(events.some((e:{action:string;actorName:string})=>e.action==='purged'&&e.actorName==='Sistema')).toBe(true);
 });

});
