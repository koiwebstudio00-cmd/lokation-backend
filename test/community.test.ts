import request from 'supertest';
import {beforeAll,describe,it,expect} from 'vitest';
import {buildApp} from '../src/app.js';
import {runWithContext} from '../src/lib/prisma.js';
import {adminDb,DB_AVAILABLE,seedTenantWithUsers,TEST_PASSWORD,truncateAll} from './helpers.js';
describe.runIf(DB_AVAILABLE)('Community: permisos y aislamiento',()=>{
 const app=buildApp(),admin=request.agent(app),community=request.agent(app);
 let a:Awaited<ReturnType<typeof seedTenantWithUsers>>,b:typeof a,cs:string,ca:string,uid:string,own:string,shared:string,privateId:string,folder:string;
 const pdf=Buffer.from('%PDF-1.4\nCommunity QA\n%%EOF\n');
 const post=(path:string,body:object)=>community.post(path).set('x-csrf-token',cs).send(body);
 const patch=(path:string,body:object)=>community.patch(path).set('x-csrf-token',cs).send(body);
 const upload=async(client:typeof admin,csrf:string,title:string,folderId?:string)=>(await client.post('/v1/rental-documents').set('x-csrf-token',csrf).query({title,kind:'otro',originalName:'qa.pdf',...(folderId?{folderId}:{})}).set('Content-Type','application/octet-stream').send(pdf).expect(201)).body.document.id as string;
 beforeAll(async()=>{
  await truncateAll();a=await seedTenantWithUsers('community-a');b=await seedTenantWithUsers('community-b');
  const user=await adminDb().user.create({data:{tenantId:a.tenant.id,nombre:'Community QA',email:'community@qa.test',passwordHash:a.agente.passwordHash,rol:'community'}});uid=user.id;
  ca=(await admin.post('/v1/auth/login').send({email:a.admin.email,password:TEST_PASSWORD}).expect(200)).body.csrf_token;
  cs=(await community.post('/v1/auth/login').send({email:user.email,password:TEST_PASSWORD}).expect(200)).body.csrf_token;
 });
 it('permite sesión y bloquea módulos administrativos, consultas y notificaciones antiguas',async()=>{
  expect((await community.get('/v1/auth/me').expect(200)).body.user.rol).toBe('community');
  for(const path of ['/v1/leads','/v1/users','/v1/analytics','/v1/rental-contracts','/v1/clients','/v1/conversations','/v1/notifications','/v1/vault-activity'])await community.get(path).expect(403);
 });
 it('lee propiedades propias y ajenas del tenant pero nunca modifica ni obtiene acceso de fotos',async()=>{
  const prop=await adminDb().property.create({data:{tenantId:a.tenant.id,userId:uid,titulo:'Propiedad anterior',administrationOnly:true,slug:'community-own',operacion:'venta',tipo:'casa',precio:100,moneda:'USD'}});
  const foreign=await adminDb().property.create({data:{tenantId:b.tenant.id,userId:b.admin.id,titulo:'Ajena',slug:'community-foreign',operacion:'venta',tipo:'casa',precio:200,moneda:'USD'}});
  expect((await community.get('/v1/properties').expect(200)).body.data.map((p:{id:string})=>p.id)).toContain(prop.id);
  await community.get(`/v1/properties/${prop.id}`).expect(200);await community.get(`/v1/properties/${foreign.id}`).expect(404);
  await patch(`/v1/properties/${prop.id}`,{titulo:'Prohibido'}).expect(403);
  await post(`/v1/properties/${prop.id}/images/presign`,{count:1}).expect(403);
  await post('/v1/properties',{titulo:'No',operacion:'venta',tipo:'casa',precio:1}).expect(403);
  expect(await runWithContext({rol:'community',tenantId:a.tenant.id,userId:uid},tx=>tx.property.updateMany({where:{id:prop.id},data:{titulo:'SQL forbidden'}}))).toEqual({count:0});
 });
 it('sube archivos propios y solo consulta los compartidos con toda la inmobiliaria',async()=>{
  own=await upload(community,cs,'Propio');privateId=await upload(admin,ca,'Privado');shared=await upload(admin,ca,'Equipo');
  await admin.patch(`/v1/rental-documents/${shared}`).set('x-csrf-token',ca).send({access:{accessMode:'team',teamPermission:'edit'}}).expect(200);
  const result=(await community.get('/v1/rental-documents').expect(200)).body.data;
  expect(result.map((d:{id:string})=>d.id).sort()).toEqual([own,shared].sort());
  expect(result.find((d:{id:string})=>d.id===own).canEdit).toBe(true);expect(result.find((d:{id:string})=>d.id===shared).canEdit).toBe(false);
  await community.get(`/v1/rental-documents/${privateId}/download-ticket`).expect(404);
  await patch(`/v1/rental-documents/${own}`,{title:'Renombrado'}).expect(200);
  await patch(`/v1/rental-documents/${shared}`,{title:'Prohibido'}).expect(403);
  await patch(`/v1/rental-documents/${own}`,{access:{accessMode:'team'}}).expect(403);
  const ticket=(await community.get(`/v1/rental-documents/${shared}/download-ticket`).expect(200)).body.url;
  const url=new URL(ticket);await request(app).get(url.pathname+url.search).expect(200);
  await admin.patch(`/v1/rental-documents/${shared}`).set('x-csrf-token',ca).send({access:{accessMode:'admin'}}).expect(200);
  await request(app).get(url.pathname+url.search).expect(404);
  const grant={accessMode:'selected',grants:[{userId:uid,permission:'edit'}]};
  await admin.patch(`/v1/rental-documents/${privateId}`).set('x-csrf-token',ca).send({access:grant}).expect(200);
  await community.get(`/v1/rental-documents/${privateId}/content`).expect(404);
 });
 it('respeta ancestros privados y no permite subir en carpetas ni vincular contratos',async()=>{
  folder=(await admin.post('/v1/vault-folders').set('x-csrf-token',ca).send({name:'Equipo'}).expect(201)).body.folder.id;
  const doc=await upload(admin,ca,'Heredado',folder);
  await community.get(`/v1/rental-documents/${doc}/content`).expect(404);
  await admin.patch(`/v1/vault-folders/${folder}`).set('x-csrf-token',ca).send({access:{accessMode:'team',teamPermission:'edit'}}).expect(200);
  await community.get(`/v1/rental-documents/${doc}/content`).expect(200);
  await post('/v1/rental-documents/upload-ticket',{mode:'vault',title:'No upload',kind:'otro',originalName:'qa.pdf',size:pdf.length,folderId:folder}).expect(403);
  await post('/v1/vault-folders',{name:'No crear'}).expect(403);
  await community.get('/v1/rental-documents').query({state:'trash'}).expect(403);
  await post('/v1/rental-documents/batch',{ids:[own],action:'trash'}).expect(403);
 });
 it('actualiza solo el estado de tareas asignadas, incluso ante intentos SQL',async()=>{
  const task=(await admin.post('/v1/tasks').set('x-csrf-token',ca).send({title:'Preparar contenido',assignedToId:uid}).expect(201)).body.task;
  const other=(await admin.post('/v1/tasks').set('x-csrf-token',ca).send({title:'Tarea privada',assignedToId:a.agente.id}).expect(201)).body.task;
  expect((await community.get('/v1/tasks').query({assignedToId:a.agente.id}).expect(200)).body.data.map((t:{id:string})=>t.id)).toEqual([task.id]);
  await patch(`/v1/tasks/${task.id}`,{status:'completada'}).expect(200);await patch(`/v1/tasks/${other.id}`,{status:'completada'}).expect(404);
  await patch(`/v1/tasks/${task.id}`,{assignedToId:uid}).expect(400);await post('/v1/tasks',{title:'No crear',assignedToId:uid}).expect(403);
  await expect(runWithContext({rol:'community',tenantId:a.tenant.id,userId:uid},tx=>tx.teamTask.update({where:{id:task.id},data:{title:'No SQL'}}))).rejects.toThrow();
 });
 it('crea feedback y participa en publicaciones de otros usuarios',async()=>{
  const ownFeedback=(await post('/v1/feedback',{tipo:'sugerencia',titulo:'Idea community',descripcion:'Contenido de prueba'}).expect(201)).body.item.id;
  const foreign=(await admin.post('/v1/feedback').set('x-csrf-token',ca).send({tipo:'sugerencia',titulo:'Privada',descripcion:'Solo admin'}).expect(201)).body.item.id;
  await community.get(`/v1/feedback/${ownFeedback}`).expect(200);await community.get(`/v1/feedback/${foreign}`).expect(200);
  await post(`/v1/feedback/${foreign}/comentarios`,{cuerpo:'Seguimiento compartido'}).expect(201);
  await patch(`/v1/feedback/${ownFeedback}`,{estado:'resuelta'}).expect(403);
 });
 it('admin asigna el nuevo rol e invita; un cambio revoca la sesión con rol antiguo',async()=>{
  await admin.post('/v1/invitations').set('x-csrf-token',ca).send({email:'nuevo-community@qa.test',rol:'community'}).expect(201);
  await admin.patch(`/v1/users/${a.agente.id}`).set('x-csrf-token',ca).send({rol:'community'}).expect(200);
  await admin.patch(`/v1/users/${uid}`).set('x-csrf-token',ca).send({rol:'agente'}).expect(200);
  await community.get('/v1/auth/me').expect(401);
 });
});
