import request from "supertest";
import {beforeAll,describe,expect,it} from "vitest";
import {buildApp} from "../src/app.js";
import {adminDb,DB_AVAILABLE,seedTenantWithUsers,TEST_PASSWORD,truncateAll} from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Bóveda: ordenamiento, filtros y fecha de modificación",()=>{
 const app=buildApp(),admin=request.agent(app),agent=request.agent(app);let a:Awaited<ReturnType<typeof seedTenantWithUsers>>,csrf:string,csrfAgent:string,folder:string,doc:string;
 beforeAll(async()=>{
  await truncateAll();a=await seedTenantWithUsers("vault-order");const b=await seedTenantWithUsers("vault-order-other");
  csrf=(await admin.post('/v1/auth/login').send({email:a.admin.email,password:TEST_PASSWORD})).body.csrf_token;
  csrfAgent=(await agent.post('/v1/auth/login').send({email:a.agente.email,password:TEST_PASSWORD})).body.csrf_token;
  const f=await admin.post('/v1/vault-folders').set('x-csrf-token',csrf).send({name:'Ordenamiento'});folder=f.body.folder.id;
  await admin.patch(`/v1/vault-folders/${folder}`).set('x-csrf-token',csrf).send({access:{accessMode:'team',teamPermission:'edit'}}).expect(200);
  for(let i=29;i>=0;i--){const d=await adminDb().rentalDocument.create({data:{tenantId:a.tenant.id,uploadedById:a.admin.id,title:`Archivo ${String(i).padStart(2,'0')}`,kind:'otro',visibility:'interna',storageKey:`fake-sort-${i}`,size:100+i,folderId:folder,accessMode:i===0?'admin':'inherit',createdAt:new Date('2020-01-01'),updatedAt:new Date(i===29?'2026-01-01':'2020-01-01')}});if(i===1)doc=d.id;}
  await adminDb().rentalDocument.create({data:{tenantId:b.tenant.id,uploadedById:b.admin.id,title:'Archivo ajeno',kind:'otro',visibility:'interna',storageKey:'fake-sort-foreign',size:99999,accessMode:'team'}});
 });
 it('ordena antes de paginar y conserva filtros en ambas páginas',async()=>{
  const first=await admin.get('/v1/rental-documents').query({sort:'name',direction:'asc',folderId:folder});expect(first.body.meta.total).toBe(30);expect(first.body.data).toHaveLength(24);expect(first.body.data[0].title).toBe('Archivo 00');expect(first.body.data[23].title).toBe('Archivo 23');
  const second=await admin.get('/v1/rental-documents').query({sort:'name',direction:'asc',folderId:folder,page:2});expect(second.body.data.map((d:{title:string})=>d.title)).toEqual(['Archivo 24','Archivo 25','Archivo 26','Archivo 27','Archivo 28','Archivo 29']);
  const size=await admin.get('/v1/rental-documents').query({sort:'size',direction:'desc'});expect(size.body.data[0].size).toBe(129);
  const modified=await admin.get('/v1/rental-documents').query({sort:'modified',direction:'desc'});expect(modified.body.data[0].title).toBe('Archivo 29');
 });
 it('carga bloques de 15 sin duplicar y valida el tamaño solicitado',async()=>{
  const query={sort:'name',direction:'asc',folderId:folder,limit:15};
  const first=await admin.get('/v1/rental-documents').query(query).expect(200);
  const second=await admin.get('/v1/rental-documents').query({...query,page:2}).expect(200);
  expect(first.body.data).toHaveLength(15);expect(second.body.data).toHaveLength(15);
  const ids=[...first.body.data,...second.body.data].map((d:{id:string})=>d.id);
  expect(new Set(ids).size).toBe(30);expect(first.body.meta.limit).toBe(15);
  expect((await admin.get('/v1/rental-documents').query({...query,page:3})).body.data).toHaveLength(0);
  const suggestions=await agent.get('/v1/rental-documents').query({q:'Archivo',limit:5,sort:'name',direction:'asc'}).expect(200);
  expect(suggestions.body.data).toHaveLength(5);expect(suggestions.body.data[0].title).toBe('Archivo 01');
  await admin.get('/v1/rental-documents').query({limit:25}).expect(400);
  await admin.get('/v1/rental-documents').query({limit:0}).expect(400);
 });
 it('filtra acceso/fecha y no revela privados ni otros tenants',async()=>{
  const visible=await agent.get('/v1/rental-documents').query({sort:'name',direction:'asc',q:'Archivo'});expect(visible.body.meta.total).toBe(29);expect(visible.body.data[0].title).toBe('Archivo 01');
  expect((await agent.get('/v1/rental-documents').query({accessMode:'admin'})).body.meta.total).toBe(0);
  expect((await admin.get('/v1/rental-documents').query({modified:'day'})).body.meta.total).toBe(0);
  await admin.get('/v1/rental-documents').query({sort:'storageKey'}).expect(400);
 });
 it('renombrar y mover actualiza fecha, listar no; permite edición con RLS',async()=>{
  const old=await adminDb().rentalDocument.findUniqueOrThrow({where:{id:doc}});
  const renamed=await agent.patch(`/v1/rental-documents/${doc}`).set('x-csrf-token',csrfAgent).send({title:'Renombrado reciente'});expect(renamed.status).toBe(200);
  expect(new Date(renamed.body.document.updatedAt).getTime()).toBeGreaterThan(old.updatedAt.getTime());
  const listed=await admin.get('/v1/rental-documents').query({modified:'day',sort:'modified',direction:'desc'});expect(listed.body.meta.total).toBe(1);expect(listed.body.data[0].id).toBe(doc);
  const after=await adminDb().rentalDocument.findUniqueOrThrow({where:{id:doc}});expect(after.updatedAt.toISOString()).toBe(renamed.body.document.updatedAt);
  const moved=await admin.patch(`/v1/rental-documents/${doc}`).set('x-csrf-token',csrf).send({folderId:null,access:{accessMode:'admin'},confirmAccessChange:true});expect(moved.status).toBe(200);expect(new Date(moved.body.document.updatedAt).getTime()).toBeGreaterThanOrEqual(after.updatedAt.getTime());expect(moved.body.document.createdAt).toBe(old.createdAt.toISOString());
  const folderBefore=await adminDb().vaultFolder.findUniqueOrThrow({where:{id:folder}});
  await admin.patch(`/v1/vault-folders/${folder}`).set('x-csrf-token',csrf).send({name:'Carpeta renombrada'}).expect(200);
  expect((await adminDb().vaultFolder.findUniqueOrThrow({where:{id:folder}})).updatedAt.getTime()).toBeGreaterThanOrEqual(folderBefore.updatedAt.getTime());
 });
});
