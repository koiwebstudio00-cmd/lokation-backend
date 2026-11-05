import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("Legajos por contrato", () => {
  const app = buildApp(), admin = request.agent(app), other = request.agent(app), agent = request.agent(app);
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>, b: typeof a;
  let csrf: string, csrfB: string, contractId: string, renter: string, guarantor: string, outsider: string, foreign: string, documentId: string;
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  beforeAll(async () => {
    await truncateAll(); a = await seedTenantWithUsers("dossier-a"); b = await seedTenantWithUsers("dossier-b");
    csrf = (await admin.post("/v1/auth/login").send({email:a.admin.email,password:TEST_PASSWORD})).body.csrf_token;
    csrfB = (await other.post("/v1/auth/login").send({email:b.admin.email,password:TEST_PASSWORD})).body.csrf_token;
    await agent.post("/v1/auth/login").send({email:a.agente.email,password:TEST_PASSWORD});
    const db=adminDb();
    const property=await db.property.create({data:{tenantId:a.tenant.id,userId:a.admin.id,titulo:"Legajo QA",slug:"dossier-qa",operacion:"alquiler",tipo:"casa",precio:1000,moneda:"ARS"}});
    const owner=await db.rentalPerson.create({data:{tenantId:a.tenant.id,createdById:a.admin.id,nombre:"Dueño",roles:["propietario"]}});
    renter=(await db.rentalPerson.create({data:{tenantId:a.tenant.id,createdById:a.admin.id,nombre:"Inquilino",roles:["inquilino"]}})).id;
    guarantor=(await db.rentalPerson.create({data:{tenantId:a.tenant.id,createdById:a.admin.id,nombre:"Garante legajo",roles:["garante"]}})).id;
    outsider=(await db.rentalPerson.create({data:{tenantId:a.tenant.id,createdById:a.admin.id,nombre:"Sin vínculo",roles:["garante"]}})).id;
    foreign=(await db.rentalPerson.create({data:{tenantId:b.tenant.id,createdById:b.admin.id,nombre:"Otro tenant",roles:["garante"]}})).id;
    contractId=(await db.rentalContract.create({data:{tenantId:a.tenant.id,createdById:a.admin.id,propertyId:property.id,ownerPersonId:owner.id,tenantPersonId:renter,startDate:new Date("2026-01-01"),endDate:new Date("2028-12-31"),monthlyRent:1000,currency:"ARS",dueDay:10}})).id;
  });
  const upload = (personId: string, extra = {}) => admin.post("/v1/rental-documents").query({title:"Documento QA",kind:"otro",originalName:"prueba.pdf",contractId,personId,dossierKind:"identidad",...extra}).set("x-csrf-token",csrf).set("Content-Type","application/octet-stream").send(pdf);
  it("vincula garantes sin duplicarlos y rechaza personas ajenas",async()=>{
    const add=(personId:string)=>admin.post(`/v1/rental-contracts/${contractId}/guarantors`).set("x-csrf-token",csrf).send({personId});
    expect((await add(foreign)).status).toBe(400); expect((await add(renter)).status).toBe(400);
    expect((await add(guarantor)).status).toBe(201); expect((await add(guarantor)).status).toBe(201);
    const people=await admin.get(`/v1/rental-contracts/${contractId}/dossier`);
    expect(people.body.tenant.id).toBe(renter); expect(people.body.guarantors).toHaveLength(1);
    expect((await other.get(`/v1/rental-contracts/${contractId}/dossier`)).status).toBe(404);
    expect((await agent.get(`/v1/rental-contracts/${contractId}/dossier`)).status).toBe(403);
    expect((await upload(outsider)).status).toBe(400); expect((await upload(foreign)).status).toBe(400);
  });
  it("sube documentación del inquilino y garante reutilizando bóveda y descarga",async()=>{
    expect((await upload(renter,{dossierKind:"ingresos"})).status).toBe(201);
    const result=await upload(guarantor); expect(result.status).toBe(201); documentId=result.body.document.id;
    expect(result.body.document.visibility).toBe("interna"); expect(result.body.document.person.nombre).toBe("Garante legajo");
    const list=await admin.get("/v1/rental-documents").query({q:"Garante legajo",dossierKind:"identidad",contractId});
    expect(list.body.data).toHaveLength(1); expect(list.body.data[0].id).toBe(documentId); expect(list.body.data[0].storageKey).toBeUndefined();
    expect((await admin.get(`/v1/rental-contracts/${contractId}/documents`)).body.data).toHaveLength(2);
    const download=await admin.get(`/v1/rental-documents/${documentId}/content`); expect(download.status).toBe(200); expect(Buffer.from(download.body)).toEqual(pdf);
    expect((await other.get(`/v1/rental-documents/${documentId}/content`)).status).toBe(404);
    expect((await other.delete(`/v1/rental-documents/${documentId}`).set("x-csrf-token",csrfB)).status).toBe(404);
    expect((await agent.get(`/v1/rental-documents/${documentId}/content`)).status).toBe(403);
    expect((await admin.delete(`/v1/rental-contracts/${contractId}/guarantors/${guarantor}`).set("x-csrf-token",csrf)).status).toBe(409);
  });
  it("aplica privacidad SQL y aísla documentos y vínculos",async()=>{
    expect(await runWithContext({rol:"portal",tenantId:a.tenant.id,userId:a.admin.id},tx=>tx.rentalDocument.count({where:{id:documentId}}))).toBe(0);
    expect(await runWithContext({rol:"admin",tenantId:b.tenant.id,userId:b.admin.id},tx=>tx.rentalGuarantor.count())).toBe(0);
    await expect(adminDb().rentalDocument.update({where:{id:documentId},data:{visibility:"ambos"}})).rejects.toThrow();
    await expect(adminDb().rentalDocument.update({where:{id:documentId},data:{personId:foreign}})).rejects.toThrow();
    expect((await admin.delete(`/v1/rental-documents/${documentId}`).set("x-csrf-token",csrf)).status).toBe(200);
    expect((await admin.delete(`/v1/rental-contracts/${contractId}/guarantors/${guarantor}`).set("x-csrf-token",csrf)).status).toBe(200);
    expect((await admin.get(`/v1/rental-contracts/${contractId}/dossier`)).body.guarantors).toHaveLength(0);
  });
});
