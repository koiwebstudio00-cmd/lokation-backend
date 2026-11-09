import request from 'supertest';
import {beforeAll,describe,it,expect} from 'vitest';
import {buildApp} from '../src/app.js';
import {runWithContext} from '../src/lib/prisma.js';
import {adminDb,DB_AVAILABLE,seedTenantWithUsers,TEST_PASSWORD,truncateAll} from './helpers.js';
describe.runIf(DB_AVAILABLE)('Captaciones: permisos, vínculos y persistencia',()=>{
 const app=buildApp(),admin=request.agent(app),agent=request.agent(app),other=request.agent(app),community=request.agent(app);
 let a:Awaited<ReturnType<typeof seedTenantWithUsers>>,b:typeof a,ca:string,cs:string,cb:string,id:string,foreignId:string;
 const body={title:'Departamento a captar',address:'Calle QA 123',city:'Ciudad QA',zone:'Centro',type:'departamento',operation:'alquiler',details:{currency:'ARS',price:400000,publication:'no_publicar',keys:'En oficina'}};
 beforeAll(async()=>{
 await truncateAll();a=await seedTenantWithUsers('cap-a');b=await seedTenantWithUsers('cap-b');
 const user=await adminDb().user.create({data:{nombre:'Community',email:'community@cap.test',rol:'community',tenantId:a.tenant.id,passwordHash:a.agente.passwordHash}});
 ca=(await admin.post('/v1/auth/login').send({email:a.admin.email,password:TEST_PASSWORD}).expect(200)).body.csrf_token;
 cs=(await agent.post('/v1/auth/login').send({email:a.agente.email,password:TEST_PASSWORD}).expect(200)).body.csrf_token;
 cb=(await other.post('/v1/auth/login').send({email:b.admin.email,password:TEST_PASSWORD}).expect(200)).body.csrf_token;
 await community.post('/v1/auth/login').send({email:user.email,password:TEST_PASSWORD}).expect(200);
 });
 it('agente crea una ficha propia, conserva condiciones y no publica propiedades',async()=>{
 id=(await agent.post('/v1/captations').set('x-csrf-token',cs).send(body).expect(201)).body.item.id;
 const item=(await agent.get(`/v1/captations/${id}`).expect(200)).body.item;
 expect(item.assignedToId).toBe(a.agente.id);expect(item.details.keys).toBe('En oficina');expect(item.details.publication).toBe('no_publicar');
 expect(await adminDb().property.count()).toBe(0);
 });
 it('aísla tenants, bloquea community y protege asignaciones incluso en SQL',async()=>{
 foreignId=(await other.post('/v1/captations').set('x-csrf-token',cb).send(body).expect(201)).body.item.id;
 await agent.get(`/v1/captations/${foreignId}`).expect(404);await admin.get(`/v1/captations/${foreignId}`).expect(404);await community.get('/v1/captations').expect(403);
 expect((await agent.get('/v1/captations').expect(200)).body.meta.total).toBe(1);
 await agent.patch(`/v1/captations/${id}`).set('x-csrf-token',cs).send({...body,assignedToId:a.admin.id}).expect(403);
 await expect(runWithContext({userId:a.agente.id,tenantId:a.tenant.id,rol:'agente'},tx=>tx.captation.update({where:{id},data:{assignedToId:a.admin.id}}))).rejects.toThrow();
 });
 it('admin vincula registros existentes de su tenant y rechaza los ajenos',async()=>{
 const person=await adminDb().rentalPerson.create({data:{tenantId:a.tenant.id,createdById:a.admin.id,nombre:'Propietario QA',roles:['propietario']}});
 const foreign=await adminDb().rentalPerson.create({data:{tenantId:b.tenant.id,createdById:b.admin.id,nombre:'Ajeno',roles:['propietario']}});
 const prop=await adminDb().property.create({data:{tenantId:a.tenant.id,userId:a.admin.id,titulo:'Privada',slug:'cap-qa',tipo:'casa',operacion:'alquiler',precio:1,moneda:'ARS',administrationOnly:true}});
 await admin.patch(`/v1/captations/${id}`).set('x-csrf-token',ca).send({...body,ownerPersonId:foreign.id}).expect(400);
 await admin.patch(`/v1/captations/${id}`).set('x-csrf-token',ca).send({...body,assignedToId:b.admin.id}).expect(400);
 const r=await admin.patch(`/v1/captations/${id}`).set('x-csrf-token',ca).send({...body,ownerPersonId:person.id,propertyId:prop.id}).expect(200);
 expect(r.body.item.ownerPersonId).toBe(person.id);expect((await adminDb().property.findUniqueOrThrow({where:{id:prop.id}})).administrationOnly).toBe(true);
 expect((await agent.get(`/v1/captations/${id}`).expect(200)).body.item.ownerPersonId).toBeNull();
 await agent.patch(`/v1/captations/${id}`).set('x-csrf-token',cs).send({...body,status:'lista'}).expect(200);
 expect((await adminDb().captation.findUniqueOrThrow({where:{id}})).ownerPersonId).toBe(person.id);
 });
 it('reasignación revoca acceso previo y archivar conserva vínculos',async()=>{
 await admin.patch(`/v1/captations/${id}`).set('x-csrf-token',ca).send({...body,assignedToId:a.admin.id,status:'archivada'}).expect(200);
 await agent.get(`/v1/captations/${id}`).expect(404);
 await agent.patch(`/v1/captations/${id}`).set('x-csrf-token',cs).send(body).expect(404);
 const row=(await admin.get(`/v1/captations/${id}`).expect(200)).body.item;expect(row.propertyId).toBeTruthy();expect(row.status).toBe('archivada');
 });
 it('valida precio, estado y cuerpos inesperados',async()=>{
 await admin.post('/v1/captations').set('x-csrf-token',ca).send({...body,details:{currency:'ARS',price:-1}}).expect(400);
 await admin.post('/v1/captations').set('x-csrf-token',ca).send({...body,status:'publicada'}).expect(400);
 await admin.post('/v1/captations').set('x-csrf-token',ca).send({...body,tenantId:b.tenant.id}).expect(400);
 });
});
