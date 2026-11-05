import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithContext } from "../src/lib/prisma.js";
import { nextAdjustment, termsSchema, commissionProposal } from "../src/modules/rentals/terms.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, TEST_PASSWORD, truncateAll } from "./helpers.js";
const conditions = { effective_period: "2026-01", commission_rate: "8.00", commission_basis: "alquiler_cobrado", adjustment_method: "fijo", frequency_months: 3, first_adjustment_period: "2026-04", fixed_percent: "10.00", note: "Condiciones pactadas de prueba" };
it("valida porcentajes y reglas coherentes", () => {
  expect(termsSchema.safeParse(conditions).success).toBe(true);
  for (const change of [{commission_rate:"101"},{frequency_months:0},{adjustment_method:"ICL"},{first_adjustment_period:"2025-12"}]) expect(termsSchema.safeParse({...conditions,...change}).success).toBe(false);
  expect(termsSchema.safeParse({...conditions,adjustment_method:"ICL",fixed_percent:null}).success).toBe(true);
});
describe.runIf(DB_AVAILABLE)("Condiciones económicas", () => {
  const app = buildApp(), admin = request.agent(app), other = request.agent(app), agent = request.agent(app);
  let a: Awaited<ReturnType<typeof seedTenantWithUsers>>, b: typeof a;
  let csrf: string, csrfB: string, contractId: string, termId: string;
  const save = (body: object) => admin.post(`/v1/rental-contracts/${contractId}/terms`).set("x-csrf-token",csrf).send(body);
  beforeAll(async () => {
    await truncateAll(); a = await seedTenantWithUsers("terms-a"); b = await seedTenantWithUsers("terms-b");
    csrf = (await admin.post("/v1/auth/login").send({email:a.admin.email,password:TEST_PASSWORD})).body.csrf_token;
    csrfB = (await other.post("/v1/auth/login").send({email:b.admin.email,password:TEST_PASSWORD})).body.csrf_token;
    await agent.post("/v1/auth/login").send({email:a.agente.email,password:TEST_PASSWORD});
    const db=adminDb();
    const property=await db.property.create({data:{tenantId:a.tenant.id,userId:a.admin.id,titulo:"Administración",slug:"terms-property",operacion:"alquiler",tipo:"casa",precio:1000,moneda:"ARS"}});
    const owner=await db.rentalPerson.create({data:{tenantId:a.tenant.id,createdById:a.admin.id,nombre:"Dueño",roles:["propietario"]}});
    const renter=await db.rentalPerson.create({data:{tenantId:a.tenant.id,createdById:a.admin.id,nombre:"Inquilino",roles:["inquilino"]}});
    contractId=(await db.rentalContract.create({data:{tenantId:a.tenant.id,createdById:a.admin.id,propertyId:property.id,ownerPersonId:owner.id,tenantPersonId:renter.id,startDate:new Date("2026-01-01"),endDate:new Date("2030-12-31"),monthlyRent:"1000.25",currency:"ARS",dueDay:10,status:"vigente"}})).id;
  });
  it("versiona y propone actualización fija sin crear cargos", async () => {
    const r=await save(conditions); expect(r.status).toBe(201); termId=r.body.terms.id;
    const overview=(await admin.get(`/v1/rental-contracts/${contractId}/terms`)).body;
    expect(overview.nextAdjustmentPeriod).toBe("2026-04-01T00:00:00.000Z"); expect(overview.suggestedAmount).toBe("1100.28");
    expect(await adminDb().rentalCharge.count({where:{contractId}})).toBe(0);
    expect(await adminDb().rentalContractEvent.count({where:{contractId,action:"terms_changed"}})).toBe(1);
    const terms=await adminDb().rentalTerms.findUniqueOrThrow({where:{id:termId}});
    expect(nextAdjustment(terms,new Date("2026-04-01"),new Date("2030-12-31"))?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(nextAdjustment(terms,new Date("2030-10-01"),new Date("2030-12-31"))).toBeNull();
    const charge={concept:"alquiler",amount:new Prisma.Decimal("1000.25")};
    expect(commissionProposal(terms,charge,new Prisma.Decimal(500))?.amount).toBe("40.00");
    expect(commissionProposal({...terms,commissionBasis:"alquiler_periodo"},charge,new Prisma.Decimal(500))?.amount).toBe("80.02");
  });
  async function paidCharge(period: string, concept="alquiler") {
    const charge=await adminDb().rentalCharge.create({data:{tenantId:a.tenant.id,contractId,createdById:a.admin.id,period:new Date(period+"-01"),dueDate:new Date(period+"-10"),concept,amount:"1000.25",currency:"ARS"}});
    await adminDb().rentalPayment.create({data:{tenantId:a.tenant.id,chargeId:charge.id,createdById:a.admin.id,idempotencyKey:randomUUID(),amount:"1000.25",paidAt:new Date(period+"-10"),method:"efectivo"}});
    return charge;
  }
  it("liquida con precisión, rechaza condiciones obsoletas y preserva el historial",async()=>{
    const charge=await paidCharge("2026-02");
    const post=(body:object)=>admin.post(`/v1/rental-charges/${charge.id}/settlements`).set("x-csrf-token",csrf).send(body);
    expect((await post({use_agreed_commission:true,expected_terms_id:randomUUID(),expenses:"0"})).status).toBe(409);
    const r=await post({use_agreed_commission:true,expected_terms_id:termId,expenses:"10"});
    expect(r.status).toBe(201); expect(r.body.settlement.commission).toBe("80.02"); expect(r.body.settlement.net).toBe("910.23");
    expect(r.body.settlement.commissionDetails.proposal.termsId).toBe(termId);
    expect((await save({...conditions,commission_rate:"5"})).status).toBe(409);
    expect((await save({...conditions,effective_period:"2026-03",commission_rate:"5"})).status).toBe(201);
    expect((await adminDb().rentalSettlement.findUniqueOrThrow({where:{id:r.body.settlement.id}})).commission.toFixed(2)).toBe("80.02");
    const charges=(await admin.get(`/v1/rental-contracts/${contractId}/charges`)).body.data;
    expect(charges[0].commissionProposal.rate).toBe("8.00");
  });
  it("excluye servicios y exige motivo para comisión manual",async()=>{
    const charge=await paidCharge("2026-03","servicio");
    const charges=(await admin.get(`/v1/rental-contracts/${contractId}/charges`)).body.data;
    expect(charges.find((c:{id:string})=>c.id===charge.id).commissionProposal.amount).toBe("0.00");
    const post=(body:object)=>admin.post(`/v1/rental-charges/${charge.id}/settlements`).set("x-csrf-token",csrf).send(body);
    expect((await post({commission:"10",expenses:"0"})).status).toBe(400);
    const r=await post({commission:"10",expenses:"0",note:"Honorario excepcional acordado"}); expect(r.status).toBe(201); expect(r.body.settlement.commissionDetails.mode).toBe("manual");
  });
  it("aísla tenants y restringe rol e historial SQL",async()=>{
    expect((await other.get(`/v1/rental-contracts/${contractId}/terms`)).status).toBe(404);
    expect((await other.post(`/v1/rental-contracts/${contractId}/terms`).set("x-csrf-token",csrfB).send(conditions)).status).toBe(404);
    expect((await agent.get(`/v1/rental-contracts/${contractId}/terms`)).status).toBe(403);
    expect(await runWithContext({tenantId:b.tenant.id,userId:b.admin.id,rol:"admin"},tx=>tx.rentalTerms.count())).toBe(0);
    await expect(runWithContext({tenantId:a.tenant.id,userId:a.admin.id,rol:"admin"},tx=>tx.rentalTerms.update({where:{id:termId},data:{commissionRate:99}}))).rejects.toThrow();
  });
});
