import request from 'supertest';
import {beforeAll,describe,expect,it} from 'vitest';
import {buildApp} from '../src/app.js';
import {runWithContext} from '../src/lib/prisma.js';
import {adminDb,DB_AVAILABLE,seedTenantWithUsers,TEST_PASSWORD,truncateAll} from './helpers.js';
describe.runIf(DB_AVAILABLE)('Vault batch and trash',()=>{
 const app=buildApp(),admin=request.agent(app),agent=request.agent(app),other=request.agent(app);
 let a:Awaited<ReturnType<typeof seedTenantWithUsers>>,csrf:string,csrfAgent:string,csrfOther:string,folder:string,destination:string,foreign:string;
 const ids:string[]=[];
 const pdf=Buffer.from('%PDF-1.4\nQA trash\n%%EOF\n');
 const batch=(action:string,docIds=ids,extra={})=>admin.post('/v1/rental-documents/batch').set('x-csrf-token',csrf).send({action,ids:docIds,...extra});
 beforeAll(async()=>{
  await truncateAll();a=await seedTenantWithUsers('trash-a');const b=await seedTenantWithUsers('trash-b');
  csrf=(await admin.post('/v1/auth/login').send({email:a.admin.email,password:TEST_PASSWORD})).body.csrf_token;
  csrfAgent=(await agent.post('/v1/auth/login').send({email:a.agente.email,password:TEST_PASSWORD})).body.csrf_token;
  csrfOther=(await other.post('/v1/auth/login').send({email:b.admin.email,password:TEST_PASSWORD})).body.csrf_token;
  folder=(await admin.post('/v1/vault-folders').set('x-csrf-token',csrf).send({name:'Origen'})).body.folder.id;
  destination=(await admin.post('/v1/vault-folders').set('x-csrf-token',csrf).send({name:'Destino'})).body.folder.id;
  await admin.patch(`/v1/vault-folders/${folder}`).set('x-csrf-token',csrf).send({access:{accessMode:'team',teamPermission:'edit'}}).expect(200);
  for(const title of ['Primer archivo','Segundo archivo']){
   const result=await admin.post('/v1/rental-documents').set('x-csrf-token',csrf).query({title,kind:'otro',originalName:'qa.pdf',folderId:folder}).set('Content-Type','application/octet-stream').send(pdf).expect(201);ids.push(result.body.document.id);
  }
  foreign=(await other.post('/v1/rental-documents').set('x-csrf-token',csrfOther).query({title:'Otro tenant',kind:'otro',originalName:'qa.pdf'}).set('Content-Type','application/octet-stream').send(pdf).expect(201)).body.document.id;
 });
 it('rejects agents and mixed-tenant batches atomically',async()=>{
  await agent.post('/v1/rental-documents/batch').set('x-csrf-token',csrfAgent).send({action:'trash',ids}).expect(403);
  await batch('trash',[ids[0],foreign]).expect(404);
  expect(await adminDb().rentalDocument.count({where:{id:{in:ids},deletedAt:null}})).toBe(2);
  await batch('trash',[]).expect(400);
  await batch('trash',Array(101).fill(ids[0])).expect(400);
 });
 it('trashes without losing bytes/ACL and invalidates existing tickets',async()=>{
  const before=await adminDb().rentalDocument.findUniqueOrThrow({where:{id:ids[0]}});
  const ticket=await agent.get(`/v1/rental-documents/${ids[0]}/download-ticket`).expect(200);const url=new URL(ticket.body.url);
  await batch('trash').expect(200);
  expect((await admin.get('/v1/rental-documents')).body.meta.total).toBe(0);
  expect((await admin.get('/v1/rental-documents').query({state:'trash',limit:15})).body.meta.total).toBe(2);
  await agent.get('/v1/rental-documents').query({state:'trash'}).expect(403);
  await admin.get(`/v1/rental-documents/${ids[0]}/content`).expect(404);
  await admin.get(`/v1/rental-documents/${ids[0]}/download-ticket`).expect(404);
  await request(app).get(url.pathname+url.search).expect(404);
  expect(await runWithContext({rol:'agente',tenantId:a.tenant.id,userId:a.agente.id},tx=>tx.rentalDocument.count())).toBe(0);
  await admin.patch(`/v1/rental-documents/${ids[0]}`).set('x-csrf-token',csrf).send({title:'No editar papelera'}).expect(404);
  const after=await adminDb().rentalDocument.findUniqueOrThrow({where:{id:ids[0]}});
  expect(after.storageKey).toBe(before.storageKey);expect(after.folderId).toBe(folder);expect(after.accessMode).toBe(before.accessMode);expect(after.grants).toEqual(before.grants);
  expect(after.deletedById).toBe(a.admin.id);
 });
 it('restores using current folder permissions, not an old grant snapshot',async()=>{
  await admin.patch(`/v1/vault-folders/${folder}`).set('x-csrf-token',csrf).send({access:{accessMode:'admin'}}).expect(200);
  await batch('restore',[ids[0],foreign]).expect(404);
  expect((await admin.get('/v1/rental-documents').query({state:'trash'})).body.meta.total).toBe(2);
  await batch('restore').expect(200);
  expect((await admin.get(`/v1/rental-documents/${ids[0]}/content`)).body).toEqual(pdf);
  await agent.get(`/v1/rental-documents/${ids[0]}/content`).expect(404);
  await batch('restore').expect(200);
  expect((await admin.get('/v1/rental-documents').query({state:'trash'})).body.meta.total).toBe(0);
 });
 it('moves only with confirmation and preserves inherited permissions',async()=>{
  await batch('move',ids,{folderId:destination}).expect(400);
  await batch('move',ids,{folderId:null,confirmAccessChange:true}).expect(400);
  expect((await adminDb().rentalDocument.findMany({where:{id:{in:ids}}})).every(d=>d.folderId===folder)).toBe(true);
  await batch('move',ids,{folderId:destination,confirmAccessChange:true}).expect(200);
  expect((await adminDb().rentalDocument.findMany({where:{id:{in:ids}}})).every(d=>d.folderId===destination&&d.accessMode==='inherit')).toBe(true);
 });
 it('moves mixed folder/file selections without flattening descendants and rejects cycles',async()=>{
  const child=(await admin.post('/v1/vault-folders').set('x-csrf-token',csrf).send({name:'Hija',parentId:destination}).expect(201)).body.folder.id;
  await batch('move',[ids[0]],{folderId:child,confirmAccessChange:true}).expect(200);
  await batch('move',[ids[0]],{folderIds:[destination,child],folderId:folder,confirmAccessChange:true}).expect(200);
  expect((await adminDb().vaultFolder.findUniqueOrThrow({where:{id:destination}})).parentId).toBe(folder);
  expect((await adminDb().vaultFolder.findUniqueOrThrow({where:{id:child}})).parentId).toBe(destination);
  expect((await adminDb().rentalDocument.findUniqueOrThrow({where:{id:ids[0]}})).folderId).toBe(child);
  await batch('move',[],{folderIds:[folder],folderId:child,confirmAccessChange:true}).expect(400);
  await batch('move',[ids[0]],{folderIds:[destination,child],folderId:null,confirmAccessChange:true}).expect(200);
  expect((await adminDb().vaultFolder.findUniqueOrThrow({where:{id:destination}})).parentId).toBeNull();
  expect((await adminDb().vaultFolder.findUniqueOrThrow({where:{id:child}})).parentId).toBe(destination);
  expect((await adminDb().rentalDocument.findUniqueOrThrow({where:{id:ids[0]}})).folderId).toBe(child);

  const foreignFolder=(await other.post('/v1/vault-folders').set('x-csrf-token',csrfOther).send({name:'Ajena'})).body.folder.id;
  await batch('move',[],{folderIds:[child,foreignFolder],folderId:folder,confirmAccessChange:true}).expect(404);
  expect((await adminDb().vaultFolder.findUniqueOrThrow({where:{id:child}})).parentId).toBe(destination);
 });

 it('trashes/restores folder trees preserving earlier trash and file links',async()=>{
  const child=(await admin.post('/v1/vault-folders').set('x-csrf-token',csrf).send({name:'Previamente eliminada',parentId:destination}).expect(201)).body.folder.id;
  await batch('trash',[],{folderIds:[child]}).expect(200);
  const before=await adminDb().rentalDocument.findUniqueOrThrow({where:{id:ids[0]}});
  await batch('trash',[],{folderIds:[destination]}).expect(200);
  expect((await admin.get('/v1/vault-folders')).body.data.some((f:{id:string})=>f.id===destination)).toBe(false);
  expect((await admin.get('/v1/vault-folders').query({state:'trash'})).body.data.some((f:{id:string})=>f.id===destination)).toBe(true);
  await agent.get('/v1/vault-folders').query({state:'all'}).expect(403);
  await batch('restore',[ids[0]]).expect(409);
  await admin.get(`/v1/rental-documents/${ids[0]}/content`).expect(404);
  await admin.post('/v1/rental-documents').set('x-csrf-token',csrf).query({title:'Bloqueado',kind:'otro',originalName:'qa.pdf',folderId:destination}).set('Content-Type','application/octet-stream').send(pdf).expect(403);
  await batch('restore',[],{folderIds:[destination]}).expect(200);
  const after=await adminDb().rentalDocument.findUniqueOrThrow({where:{id:ids[0]}});
  expect(after.deletedAt).toBeNull();expect(after.storageKey).toBe(before.storageKey);expect(after.folderId).toBe(before.folderId);expect(after.contractId).toBe(before.contractId);expect(after.accessMode).toBe(before.accessMode);
  expect((await adminDb().vaultFolder.findUniqueOrThrow({where:{id:child}})).deletedAt).not.toBeNull();
  await batch('restore',[],{folderIds:[child]}).expect(200);
 });
 it('records attributable activity, isolates tenants and prohibits audit writes',async()=>{
  const result=await admin.get('/v1/vault-activity').query({entityId:destination}).expect(200);
  expect(result.body.data.map((e:{action:string})=>e.action)).toEqual(expect.arrayContaining(['created','moved','trashed','restored']));
  expect(result.body.data.every((e:{actorId:string})=>e.actorId===a.admin.id)).toBe(true);
  expect((await other.get('/v1/vault-activity').query({entityId:destination}).expect(200)).body.data).toEqual([]);
  await agent.get('/v1/vault-activity').expect(403);
  expect(await runWithContext({rol:'admin',tenantId:a.tenant.id,userId:a.admin.id},tx=>tx.vaultActivity.deleteMany())).toEqual({count:0});
  await expect(runWithContext({rol:'admin',tenantId:a.tenant.id,userId:a.admin.id},tx=>tx.vaultActivity.create({data:{tenantId:a.tenant.id,actorName:'Falso',entityId:destination,entityType:'folder',entityName:'Falso',action:'created'}}))).rejects.toThrow();
  const count=await adminDb().vaultActivity.count({where:{entityId:destination}});
  await admin.get('/v1/vault-folders');
  expect(await adminDb().vaultActivity.count({where:{entityId:destination}})).toBe(count);
 });

});
