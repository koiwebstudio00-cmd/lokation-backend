// Verifica que el seed local permita recorrer las pantallas y respete RLS.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { getPrisma, runWithContext } from "../src/lib/prisma.js";
import { readRentalPdf } from "../src/lib/rental-documents-storage.js";

const ownerUrl = process.env.DATABASE_URL_MIGRATE;
const runtimeUrl = process.env.DATABASE_URL;
function localDev(value: string | undefined) {
  if (!value) return false;
  const url = new URL(value);
  return ["localhost", "127.0.0.1"].includes(url.hostname)
    && url.port === "5433" && url.pathname === "/ubikka_dev";
}
if (!localDev(ownerUrl) || !localDev(runtimeUrl)) {
  throw new Error("La verificación sólo usa ubikka_dev local (localhost:5433).");
}

const db = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
try {
  const fixtures = [];
  for (const suffix of ["a", "b"]) {
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: `demo-${suffix}` } });
    const admin = await db.user.findUniqueOrThrow({ where: { email: `admin@demo-${suffix}.test` } });
    const ctx = { tenantId: tenant.id, userId: admin.id, rol: "admin" as const };
    const result = await runWithContext(ctx, async (tx) => {
      const [properties, people, leads, images, feedback, contracts, services, maintenance, charges, adjustments, settlements, inquiries, documents] = await Promise.all([
        tx.property.findMany({ select: { id: true, slug: true } }),
        tx.rentalPerson.findMany({ select: { id: true, email: true } }),
        tx.lead.findMany({ select: { canalRef: true } }),
        tx.propertyImage.count(),
        tx.feedbackItem.count(),
        tx.rentalContract.findMany({ select: { id: true, propertyId: true, status: true, startDate: true } }),
        tx.rentalServiceAccount.findMany({ select: { id: true, propertyId: true, type: true, active: true } }),
        tx.maintenanceRequest.findMany({ select: { id: true, propertyId: true, status: true } }),
        tx.rentalCharge.findMany({ include: { payments: true } }),
        tx.rentalAdjustment.findMany(),
        tx.rentalSettlement.findMany(),
        tx.rentalInquiry.findMany(),
        tx.rentalDocument.findMany()
      ]);
      return { properties, people, leads, images, feedback, contracts, services, maintenance, charges, adjustments, settlements, inquiries, documents };
    });
    const requiredSlugs = ["venta-casa", "alquiler-departamento", "alquiler-cobros", "mixta-local"].map((name) => `${name}-demo-${suffix}`);
    const requiredLeads = ["nueva", "en-contacto", "ganada", "perdida"].map((name) => `seed-demo-${suffix}-${name}`);
    const demoProperty = result.properties.find((property) => property.slug === `alquiler-departamento-demo-${suffix}`);
    const demoContracts = result.contracts.filter((contract) => contract.propertyId === demoProperty?.id
      && contract.startDate.toISOString().slice(0, 10) === "2026-11-01");
    if (requiredSlugs.some((slug) => !result.properties.some((p) => p.slug === slug))
      || requiredLeads.some((ref) => !result.leads.some((l) => l.canalRef === ref))
      || !result.people.some((p) => p.email === `propietario@alquiler-demo-${suffix}.test`)
      || !result.people.some((p) => p.email === `inquilino@alquiler-demo-${suffix}.test`)
      || !result.people.some((p) => p.email === `garante@alquiler-demo-${suffix}.test`)
      || result.images < 3 || result.feedback < 2
      || demoContracts.length !== 1 || demoContracts[0].status !== "borrador"
      || result.services.filter((item) => item.propertyId === demoProperty?.id && item.active).length < 2
      || !result.maintenance.some((item) => item.propertyId === demoProperty?.id && item.status === "abierta")
      || !result.charges.some((item) => item.period.toISOString().slice(0, 7) === "2026-10"
        && item.payments.some((payment) => !payment.voidedAt))
      || !result.charges.some((item) => item.period.toISOString().slice(0, 7) === "2026-09"
        && item.payments.some((payment) => !payment.voidedAt && payment.amount.equals(item.amount)))
      || !result.adjustments.some((item) => item.effectivePeriod.toISOString().slice(0, 7) === "2026-11")
      || !result.settlements.some((item) => item.status === (suffix === "a" ? "pagada" : "preparada"))
      || !result.inquiries.some((item) => item.status === "abierta")
      || !result.inquiries.some((item) => item.status === "resuelta")
      || !result.documents.some((item) => item.visibility === "ambos")) {
      throw new Error(`Fixtures incompletas en demo-${suffix}. Ejecutá npm run seed.`);
    }
    const renter = result.people.find((person) => person.email === `inquilino@alquiler-demo-${suffix}.test`)!;
    const owner = result.people.find((person) => person.email === `propietario@alquiler-demo-${suffix}.test`)!;
    const renterAccount = await db.rentalPortalAccount.findUniqueOrThrow({ where: { email: renter.email! } });
    const ownerAccount = await db.rentalPortalAccount.findUniqueOrThrow({ where: { email: owner.email! } });
    for (const [personId, accountId] of [[renter.id, renterAccount.id], [owner.id, ownerAccount.id]]) {
      const access = await db.rentalPortalAccess.findUniqueOrThrow({ where: { tenantId_personId: { tenantId: tenant.id, personId } } });
      if (!access.active || access.accountId !== accountId) throw new Error(`Acceso de portal incompleto en demo-${suffix}`);
    }
    const visibleContracts = await runWithContext({ tenantId: tenant.id, userId: renterAccount.id, rol: "portal" },
      (tx) => tx.rentalContract.findMany({ select: { id: true, status: true } }));
    if (visibleContracts.length !== 1 || visibleContracts[0].status !== "vigente") {
      throw new Error(`Contratos del portal incorrectos en demo-${suffix}`);
    }
    const portalProperty = result.properties.find((property) => property.slug === `alquiler-cobros-demo-${suffix}`);
    const portalState = await runWithContext({ tenantId: tenant.id, userId: renterAccount.id, rol: "portal" },
      async (tx) => ({
        services: await tx.rentalServiceAccount.findMany({ where: { propertyId: portalProperty?.id } }),
        maintenance: await tx.maintenanceRequest.findMany({ where: { contractId: visibleContracts[0].id } })
      }));
    if (portalState.services.length < 2 || !portalState.maintenance.some((item) => item.status === "en_gestion")) {
      throw new Error(`Servicios o mantenimiento ausentes del portal en demo-${suffix}`);
    }
    const pdf = await readRentalPdf(result.documents[0].storageKey);
    if (pdf.toString("ascii", 0, 5) !== "%PDF-") throw new Error(`PDF ficticio inválido en demo-${suffix}`);
    fixtures.push({ suffix, ctx, personId: result.people[0].id, contractId: demoContracts[0].id,
      serviceId: result.services[0].id, maintenanceId: result.maintenance[0].id,
      chargeId: result.charges[0].id, adjustmentId: result.adjustments[0].id,
      settlementId: result.settlements[0].id, inquiryId: result.inquiries[0].id,
      documentId: result.documents[0].id });
    console.log(`demo-${suffix}: contratos, portal, consultas, PDF privado, cobros, ajustes y liquidaciones OK`);
  }
  for (const fixture of fixtures) {
    const other = fixtures.find((item) => item.suffix !== fixture.suffix)!;
    const leaked = await runWithContext(fixture.ctx, (tx) => tx.rentalPerson.findUnique({ where: { id: other.personId } }));
    if (leaked) throw new Error(`Aislamiento roto entre demo-${fixture.suffix} y demo-${other.suffix}`);
    const contractLeak = await runWithContext(fixture.ctx, (tx) => tx.rentalContract.findUnique({ where: { id: other.contractId } }));
    if (contractLeak) throw new Error(`Contrato ajeno visible para demo-${fixture.suffix}`);
    const serviceLeak = await runWithContext(fixture.ctx, (tx) => tx.rentalServiceAccount.findUnique({ where: { id: other.serviceId } }));
    if (serviceLeak) throw new Error(`Servicio ajeno visible para demo-${fixture.suffix}`);
    const maintenanceLeak = await runWithContext(fixture.ctx, (tx) => tx.maintenanceRequest.findUnique({ where: { id: other.maintenanceId } }));
    if (maintenanceLeak) throw new Error(`Mantenimiento ajeno visible para demo-${fixture.suffix}`);
    const chargeLeak = await runWithContext(fixture.ctx, (tx) => tx.rentalCharge.findUnique({ where: { id: other.chargeId } }));
    if (chargeLeak) throw new Error(`Cargo ajeno visible para demo-${fixture.suffix}`);
    const adjustmentLeak = await runWithContext(fixture.ctx, (tx) => tx.rentalAdjustment.findUnique({ where: { id: other.adjustmentId } }));
    if (adjustmentLeak) throw new Error(`Ajuste ajeno visible para demo-${fixture.suffix}`);
    const settlementLeak = await runWithContext(fixture.ctx, (tx) => tx.rentalSettlement.findUnique({ where: { id: other.settlementId } }));
    if (settlementLeak) throw new Error(`Liquidación ajena visible para demo-${fixture.suffix}`);
    const inquiryLeak = await runWithContext(fixture.ctx, (tx) => tx.rentalInquiry.findUnique({ where: { id: other.inquiryId } }));
    if (inquiryLeak) throw new Error(`Consulta ajena visible para demo-${fixture.suffix}`);
    const documentLeak = await runWithContext(fixture.ctx, (tx) => tx.rentalDocument.findUnique({ where: { id: other.documentId } }));
    if (documentLeak) throw new Error(`Documento ajeno visible para demo-${fixture.suffix}`);
  }
  console.log("Aislamiento RLS entre demo-a y demo-b OK");
} finally {
  await getPrisma().$disconnect();
  await db.$disconnect();
}
