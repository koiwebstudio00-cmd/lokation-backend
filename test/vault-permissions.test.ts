import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Bóveda: carpetas y permisos",()=>{
 const app=buildApp(),admin=request.agent(app),editor=request.agent(app),other=request.agent(app);
 let a:Awaited<ReturnType<typeof seedTenantWithUsers>>,b:typeof a;
 let csrf:string,csrfE:string,root:string,child:string,doc:string,legacy:string;
 const pdf=Buffer.from("%PDF-1.4\nTest private vault\n%%EOF\n");
 const patchFolder=(id:string,body:unknown)=>admin.patch(`/v1/vault-folders/${id}`).set("x-csrf-token",csrf).send(body);
 const patchDoc=(id:string,body:unknown)=>admin.patch(`/v1/rental-documents/${id}`).set("x-csrf-token",csrf).send(body);
 beforeAll(async()=>{
  await truncateAll();a=await seedTenantWithUsers("vault-permissions-a");b=await seedTenantWithUsers("vault-permissions-b");
  csrf=(await admin.post("/v1/auth/login").send({email:a.admin.email,password:TEST_PASSWORD})).body.csrf_token;
  csrfE=(await editor.post("/v1/auth/login").send({email:a.agente.email,password:TEST_PASSWORD})).body.csrf_token;
  await other.post("/v1/auth/login").send({email:b.admin.email,password:TEST_PASSWORD});
 });
 it("conserva privacidad de archivos sueltos y no revela permisos ajenos",async()=>{
  const upload=await admin.post("/v1/rental-documents").query({title:"Documento anterior",kind:"otro",originalName:"anterior.pdf"}).set("x-csrf-token",csrf).set("Content-Type","application/octet-stream").send(pdf);
  expect(upload.status,JSON.stringify(upload.body)).toBe(201);legacy=upload.body.document.id;
  expect(upload.body.document.accessMode).toBe("admin");
  expect((await editor.get("/v1/rental-documents")).body.data).toEqual([]);
  expect((await editor.get(`/v1/rental-documents/${legacy}/download-ticket`)).status).toBe(404);
 });
 it("crea carpetas privadas y habilita herencia sin ampliar la del padre",async()=>{
  const r=await admin.post("/v1/vault-folders").set("x-csrf-token",csrf).send({name:"Administración"});expect(r.status,JSON.stringify(r.body)).toBe(201);root=r.body.folder.id;
  const c=await admin.post("/v1/vault-folders").set("x-csrf-token",csrf).send({name:"Facturas",parentId:root});expect(c.status,JSON.stringify(c.body)).toBe(201);child=c.body.folder.id;
  expect((await editor.get("/v1/vault-folders")).body.data).toEqual([]);
  await patchFolder(child,{access:{accessMode:"team",teamPermission:"edit"}}).expect(200);
  expect((await editor.get("/v1/vault-folders")).body.data).toEqual([]);
  await patchFolder(root,{access:{accessMode:"selected",grants:[{userId:a.agente.id,permission:"read"}]}}).expect(200);
  const visible=await editor.get("/v1/vault-folders");expect(visible.body.data).toHaveLength(2);expect(visible.body.data.every((f:{canEdit:boolean})=>!f.canEdit)).toBe(true);
  expect((await other.get("/v1/vault-folders")).body.data).toEqual([]);
  expect((await patchFolder(root,{access:{accessMode:"selected",grants:[{userId:b.agente.id,permission:"read"}]}})).status).toBe(400);
 });
 it("lectura no permite subir, renombrar, compartir ni crear carpetas",async()=>{
  expect((await editor.post("/v1/vault-folders").set("x-csrf-token",csrfE).send({name:"Prohibida",parentId:root})).status).toBe(403);
  expect((await editor.patch(`/v1/vault-folders/${root}`).set("x-csrf-token",csrfE).send({name:"Prohibido"})).status).toBe(403);
  expect((await editor.post("/v1/rental-documents/upload-ticket").set("x-csrf-token",csrfE).send({mode:"vault",title:"Archivo prueba",kind:"otro",originalName:"prueba.pdf",size:pdf.length,folderId:child})).status).toBe(403);
 });
 it("edición permite crear subcarpetas y cargar directamente al VPS",async()=>{
  await patchFolder(root,{access:{accessMode:"selected",grants:[{userId:a.agente.id,permission:"edit"}]}}).expect(200);
  const created=await editor.post("/v1/vault-folders").set("x-csrf-token",csrfE).send({name:"Recibos",parentId:child});expect(created.status,JSON.stringify(created.body)).toBe(201);
  const ticket=await editor.post("/v1/rental-documents/upload-ticket").set("x-csrf-token",csrfE).send({mode:"vault",title:"Archivo compartido",kind:"otro",originalName:"prueba.pdf",size:pdf.length,folderId:child});expect(ticket.status).toBe(200);
  const upload=await request(app).post("/v1/file-transfers/upload").set("Authorization",`Bearer ${ticket.body.token}`).set("Content-Type","application/octet-stream").send(pdf);
  expect(upload.status,JSON.stringify(upload.body)).toBe(201);doc=upload.body.document.id;
  expect(upload.body.document.accessMode).toBe("inherit");
  expect((await editor.get(`/v1/rental-documents/${doc}/content`)).body).toEqual(pdf);
  await editor.patch(`/v1/rental-documents/${doc}`).set("x-csrf-token",csrfE).send({title:"Renombrado por editor"}).expect(200);
  await editor.patch(`/v1/rental-documents/${doc}`).set("x-csrf-token",csrfE).send({access:{accessMode:"team"}}).expect(403);
  await editor.delete(`/v1/rental-documents/${doc}`).set("x-csrf-token",csrfE).expect(403);
  await other.get(`/v1/rental-documents/${doc}/content`).expect(404);
  expect((await editor.get("/v1/rental-documents").query({q:"Renombrado"})).body.data).toHaveLength(1);
 });
 it("restringe un archivo y revoca tickets emitidos, también al cambiar el padre",async()=>{
  const grant=await editor.get(`/v1/rental-documents/${doc}/download-ticket`);expect(grant.status).toBe(200);const url=new URL(grant.body.url);
  await patchDoc(doc,{access:{accessMode:"admin"}}).expect(200);
  await request(app).get(url.pathname+url.search).expect(404);
  expect((await editor.get("/v1/rental-documents").query({q:"Renombrado"})).body.meta.total).toBe(0);
  await patchDoc(doc,{access:{accessMode:"inherit"}}).expect(200);
  await patchFolder(root,{access:{accessMode:"admin"}}).expect(200);
  await editor.get(`/v1/rental-documents/${doc}/content`).expect(404);
  expect(await runWithContext({rol:"agente",tenantId:a.tenant.id,userId:a.agente.id},tx=>tx.rentalDocument.count())).toBe(0);
  await admin.get(`/v1/rental-documents/${doc}/content`).expect(200);
 });
 it("mueve sin duplicar archivos ni permitir ciclos o destinos de otra inmobiliaria",async()=>{
  await patchFolder(root,{parentId:child,confirmAccessChange:true}).expect(400);
  await patchDoc(legacy,{folderId:child}).expect(400);
  await patchDoc(legacy,{folderId:child,confirmAccessChange:true}).expect(200);
  const current=await adminDb().rentalDocument.findUniqueOrThrow({where:{id:legacy}});expect(current.accessMode).toBe("admin");
  const oldKey=current.storageKey;
  await patchDoc(legacy,{folderId:null,confirmAccessChange:true,title:"Archivo organizado"}).expect(200);
  expect((await adminDb().rentalDocument.findUniqueOrThrow({where:{id:legacy}})).storageKey).toBe(oldKey);
  const foreign=await adminDb().vaultFolder.create({data:{tenantId:b.tenant.id,name:"Ajena"}});
  await patchDoc(legacy,{folderId:foreign.id,confirmAccessChange:true}).expect(403);
  await expect(runWithContext({rol:"admin",tenantId:a.tenant.id,userId:a.admin.id},tx=>tx.rentalDocument.update({where:{id:legacy},data:{folderId:foreign.id}}))).rejects.toThrow();
 });
 it("protege cambios de acceso mediante SQL y revalida permisos antes de la carga",async()=>{
  await patchFolder(root,{access:{accessMode:"team",teamPermission:"edit"}}).expect(200);
  await expect(runWithContext({rol:"agente",tenantId:a.tenant.id,userId:a.agente.id},tx=>tx.rentalDocument.update({where:{id:doc},data:{accessMode:"team"}}))).rejects.toThrow();
  const ticket=await editor.post("/v1/rental-documents/upload-ticket").set("x-csrf-token",csrfE).send({mode:"vault",title:"Revocado antes de subir",kind:"otro",originalName:"prueba.pdf",size:pdf.length,folderId:child});expect(ticket.status).toBe(200);
  await patchFolder(root,{access:{accessMode:"admin"}}).expect(200);
  await request(app).post("/v1/file-transfers/upload").set("Authorization",`Bearer ${ticket.body.token}`).set("Content-Type","application/octet-stream").send(pdf).expect(403);
 });
});
