// Seed local de Lokation: dos inmobiliarias aisladas y escenarios ficticios.
// Corre con el rol privilegiado: DATABASE_URL_MIGRATE (bypassa RLS a propósito).
// Uso: npm run seed
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import { seedClients } from "./seed-clients.js";
import { newDocumentKey, saveRentalPdf } from "../src/lib/rental-documents-storage.js";

if (process.env.NODE_ENV === "production") {
  throw new Error("El seed de demostración no puede ejecutarse en producción.");
}

const url = process.env.DATABASE_URL_MIGRATE;
if (!url) throw new Error("Falta DATABASE_URL_MIGRATE en .env");
const target = new URL(url);
if (!(["localhost", "127.0.0.1"].includes(target.hostname) && target.port === "5433" && target.pathname === "/ubikka_dev")) {
  throw new Error("El seed solo puede usarse en ubikka_dev local (localhost:5433).");
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

// Credenciales SOLO de desarrollo.
const DEV_PASSWORD = "password123";

function demoPdf(title: string): Buffer {
  const content = `BT /F1 20 Tf 72 720 Td (${title}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function main() {
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 12);

  const tenants = await Promise.all([
    prisma.tenant.upsert({
      where: { slug: "demo-a" },
      update: { nombre: "Inmobiliaria Demo A", logoUrl: null },
      create: { nombre: "Inmobiliaria Demo A", slug: "demo-a" }
    }),
    prisma.tenant.upsert({
      where: { slug: "demo-b" },
      update: { nombre: "Inmobiliaria Demo B", logoUrl: null },
      create: { nombre: "Inmobiliaria Demo B", slug: "demo-b" }
    })
  ]);

  const users = [
    { nombre: "Operador Ubikka", email: "operador@ubikka.test", rol: "super_admin" as const, tenantId: null },
    ...tenants.flatMap((tenant, index) => {
      const suffix = index === 0 ? "a" : "b";
      return [
        { nombre: `Admin Demo ${suffix.toUpperCase()}`, email: `admin@demo-${suffix}.test`, rol: "admin" as const, tenantId: tenant.id },
        { nombre: `Agente Demo ${suffix.toUpperCase()}`, email: `agente@demo-${suffix}.test`, rol: "agente" as const, tenantId: tenant.id }
      ];
    })
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { passwordHash },
      create: { ...u, passwordHash }
    });
  }

  for (const [index, tenant] of tenants.entries()) {
    const suffix = index === 0 ? "a" : "b";
    const agent = users.find((user) => user.email === `agente@demo-${suffix}.test`)!;
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: `admin@demo-${suffix}.test` } });
    const agentId = (await prisma.user.findUniqueOrThrow({ where: { email: agent.email } })).id;
    await prisma.property.upsert({
      where: { slug: `venta-casa-demo-${suffix}` },
      update: {},
      create: {
        tenantId: tenant.id,
        userId: agentId,
        titulo: `Casa de prueba ${suffix.toUpperCase()}`,
        operacion: "venta",
        tipo: "casa",
        precio: index === 0 ? 90000 : 120000,
        moneda: "USD",
        ciudad: "Ciudad de prueba",
        slug: `venta-casa-demo-${suffix}`
      }
    });

    const rentalProperty = await prisma.property.upsert({
      where: { slug: `alquiler-departamento-demo-${suffix}` },
      update: {},
      create: {
        tenantId: tenant.id, userId: agentId,
        titulo: `Departamento de alquiler demo ${suffix.toUpperCase()}`,
        descripcion: "Propiedad ficticia para probar alquileres y orden de fotos.",
        operacion: "alquiler", tipo: "departamento", precio: index === 0 ? 420000 : 530000,
        moneda: "ARS", estado: "disponible", ciudad: "Ciudad de prueba", zona: `Zona demo ${suffix.toUpperCase()}`,
        ambientes: 2, dormitorios: 1, banios: 1, destino: "vivienda",
        plazoContrato: "meses_24", ajuste: "cuatrimestral", indiceAjuste: "ipc",
        mascotas: "sin_especificar", amoblado: "sin_amoblar",
        slug: `alquiler-departamento-demo-${suffix}`
      }
    });

    await prisma.property.upsert({
      where: { slug: `mixta-local-demo-${suffix}` },
      update: {},
      create: {
        tenantId: tenant.id, userId: agentId,
        titulo: `Local mixto demo ${suffix.toUpperCase()}`,
        descripcion: "Aviso ficticio para probar venta y alquiler en una misma ficha.",
        operacion: "ambos", tipo: "local_comercial", precio: index === 0 ? 110000 : 135000,
        moneda: "USD", precioAlquiler: index === 0 ? 650000 : 730000, monedaAlquiler: "ARS",
        estado: "reservado", ciudad: "Ciudad de prueba", slug: `mixta-local-demo-${suffix}`
      }
    });

    // URLs locales ficticias: permiten verificar portada y reordenamiento sin R2.
    for (const [order, asset] of ["foto-1.svg", "foto-2.svg", "foto-3.svg"].entries()) {
      const key = `${tenant.id}/${rentalProperty.id}/demo-${order}.webp`;
      await prisma.propertyImage.upsert({
        where: { r2Key: key }, update: {},
        create: { tenantId: tenant.id, propertyId: rentalProperty.id, r2Key: key,
          url: `http://localhost:3000/demo/${asset}`, esPortada: order === 0, orden: order }
      });
    }

    for (const [role, label] of [
      ["propietario", "Propietario"], ["inquilino", "Inquilino"], ["garante", "Garante"]
    ] as const) {
      const email = `${role}@alquiler-demo-${suffix}.test`;
      const existing = await prisma.rentalPerson.findFirst({ where: { tenantId: tenant.id, email } });
      if (!existing) await prisma.rentalPerson.create({ data: {
        tenantId: tenant.id, createdById: admin.id,
        nombre: `${label} Demo ${suffix.toUpperCase()}`, email, roles: [role]
      } });
    }

    const owner = await prisma.rentalPerson.findFirstOrThrow({
      where: { tenantId: tenant.id, email: `propietario@alquiler-demo-${suffix}.test` }
    });
    const renter = await prisma.rentalPerson.findFirstOrThrow({
      where: { tenantId: tenant.id, email: `inquilino@alquiler-demo-${suffix}.test` }
    });
    for (const person of [owner, renter]) {
      const account = await prisma.rentalPortalAccount.upsert({
        where: { email: person.email! }, update: {},
        create: { email: person.email!, passwordHash }
      });
      await prisma.rentalPortalAccess.upsert({
        where: { tenantId_personId: { tenantId: tenant.id, personId: person.id } },
        update: {}, create: { tenantId: tenant.id, personId: person.id, accountId: account.id }
      });
    }
    const existingContract = await prisma.rentalContract.findFirst({
      where: { tenantId: tenant.id, propertyId: rentalProperty.id, ownerPersonId: owner.id,
        tenantPersonId: renter.id, startDate: new Date("2026-11-01T00:00:00Z") }
    });
    if (!existingContract) await prisma.rentalContract.create({ data: {
      tenantId: tenant.id, propertyId: rentalProperty.id,
      ownerPersonId: owner.id, tenantPersonId: renter.id, createdById: admin.id,
      startDate: new Date("2026-11-01T00:00:00Z"), endDate: new Date("2028-10-31T00:00:00Z"),
      monthlyRent: index === 0 ? "420000.00" : "530000.00", currency: "ARS", dueDay: 10
    } });

    const demoContract = existingContract ?? await prisma.rentalContract.findFirstOrThrow({
      where: { tenantId: tenant.id, propertyId: rentalProperty.id, ownerPersonId: owner.id,
        tenantPersonId: renter.id, startDate: new Date("2026-11-01T00:00:00Z") }
    });
    const financeProperty = await prisma.property.upsert({
      where: { slug: `alquiler-cobros-demo-${suffix}` }, update: {},
      create: { tenantId: tenant.id, userId: agentId,
        titulo: `Departamento con cobros demo ${suffix.toUpperCase()}`,
        operacion: "alquiler", tipo: "departamento", precio: index === 0 ? 380000 : 460000,
        moneda: "ARS", estado: "alquilada", ciudad: "Ciudad de prueba",
        slug: `alquiler-cobros-demo-${suffix}` }
    });
    let financeContract = await prisma.rentalContract.findFirst({
      where: { tenantId: tenant.id, propertyId: financeProperty.id, status: "vigente" }
    });
    if (!financeContract) financeContract = await prisma.rentalContract.create({ data: {
      tenantId: tenant.id, propertyId: financeProperty.id, ownerPersonId: owner.id,
      tenantPersonId: renter.id, createdById: admin.id,
      startDate: new Date("2026-01-01T00:00:00Z"), endDate: new Date("2027-12-31T00:00:00Z"),
      monthlyRent: index === 0 ? "380000.00" : "460000.00", currency: "ARS", dueDay: 10,
      status: "vigente"
    } });
    const portalMaintenance = await prisma.maintenanceRequest.findFirst({ where: {
      tenantId: tenant.id, contractId: financeContract.id,
      title: `Revisión de calefacción demo ${suffix.toUpperCase()}`
    } });
    if (!portalMaintenance) {
      const item = await prisma.maintenanceRequest.create({ data: {
        tenantId: tenant.id, propertyId: financeProperty.id, contractId: financeContract.id,
        createdById: admin.id, title: `Revisión de calefacción demo ${suffix.toUpperCase()}`,
        description: "Pedido ficticio vinculado al contrato vigente para seguirlo desde ambos portales.",
        priority: "normal", status: "en_gestion"
      } });
      await prisma.maintenanceEvent.create({ data: { tenantId: tenant.id, requestId: item.id,
        actorId: admin.id, toState: "abierta", note: "Pedido ficticio recibido" } });
      await prisma.maintenanceEvent.create({ data: { tenantId: tenant.id, requestId: item.id,
        actorId: admin.id, fromState: "abierta", toState: "en_gestion", note: "Proveedor contactado" } });
    }
    for (const service of [
      { type: "luz" as const, provider: "Energía Demo", accountNumber: `LUZ-PORTAL-${suffix.toUpperCase()}`, visibility: "ambos" as const },
      { type: "agua" as const, provider: "Aguas Demo", accountNumber: `AGUA-PORTAL-${suffix.toUpperCase()}`, visibility: "inquilino" as const }
    ]) {
      const existing = await prisma.rentalServiceAccount.findFirst({ where: {
        tenantId: tenant.id, propertyId: financeProperty.id, type: service.type,
        accountNumber: service.accountNumber
      } });
      if (!existing) await prisma.rentalServiceAccount.create({ data: {
        tenantId: tenant.id, propertyId: financeProperty.id, createdById: admin.id, ...service
      } });
    }
    const renterAccount = await prisma.rentalPortalAccount.findUniqueOrThrow({ where: { email: renter.email! } });
    const demoInquiry = await prisma.rentalInquiry.findFirst({ where: {
      tenantId: tenant.id, contractId: financeContract.id, title: `Consulta de alquiler demo ${suffix.toUpperCase()}`
    } });
    if (!demoInquiry) await prisma.rentalInquiry.create({ data: {
      tenantId: tenant.id, contractId: financeContract.id, accountId: renterAccount.id,
      category: "consulta", title: `Consulta de alquiler demo ${suffix.toUpperCase()}`,
      description: "Quisiera saber cuándo se acredita el pago informado en el portal."
    } });
    const demoComplaint = await prisma.rentalInquiry.findFirst({ where: {
      tenantId: tenant.id, contractId: financeContract.id, title: `Reclamo resuelto demo ${suffix.toUpperCase()}`
    } });
    if (!demoComplaint) await prisma.rentalInquiry.create({ data: {
      tenantId: tenant.id, contractId: financeContract.id, accountId: renterAccount.id,
      category: "reclamo", title: `Reclamo resuelto demo ${suffix.toUpperCase()}`,
      description: "La canilla de la cocina perdía agua y solicité una revisión.",
      status: "resuelta", response: "La reparación fue coordinada por mantenimiento.",
      answeredById: admin.id, answeredAt: new Date("2026-10-10T00:00:00Z")
    } });
    const documentTitle = `Contrato de ejemplo demo ${suffix.toUpperCase()}`;
    const existingDocument = await prisma.rentalDocument.findFirst({ where: {
      tenantId: tenant.id, contractId: financeContract.id, title: documentTitle
    } });
    if (!existingDocument) {
      const key = newDocumentKey(tenant.id, financeContract.id);
      const pdf = demoPdf(`Contrato demo ${suffix.toUpperCase()}`);
      await saveRentalPdf(key, pdf);
      await prisma.rentalDocument.create({ data: {
        tenantId: tenant.id, contractId: financeContract.id, uploadedById: admin.id,
        title: documentTitle, kind: "contrato", visibility: "ambos", storageKey: key, size: pdf.length
      } });
    }
    const financeCharge = await prisma.rentalCharge.upsert({
      where: { contractId_period_concept: { contractId: financeContract.id,
        period: new Date("2026-10-01T00:00:00Z"), concept: "alquiler" } },
      update: {},
      create: { tenantId: tenant.id, contractId: financeContract.id, createdById: admin.id,
        period: new Date("2026-10-01T00:00:00Z"), dueDate: new Date("2026-10-10T00:00:00Z"),
        amount: financeContract.monthlyRent, currency: "ARS", concept: "alquiler" }
    });
    const demoPaymentKey = `00000000-0000-4000-8000-00000000000${suffix}`;
    await prisma.rentalPayment.upsert({
      where: { tenantId_idempotencyKey: { tenantId: tenant.id, idempotencyKey: demoPaymentKey } },
      update: {},
      create: { tenantId: tenant.id, chargeId: financeCharge.id, createdById: admin.id,
        idempotencyKey: demoPaymentKey, amount: index === 0 ? "150000.00" : "200000.00",
        paidAt: new Date("2026-10-10T00:00:00Z"), method: "transferencia",
        reference: `DEMO-${suffix.toUpperCase()}-001`, note: "Cobro ficticio parcial" }
    });
    const settledCharge = await prisma.rentalCharge.upsert({
      where: { contractId_period_concept: { contractId: financeContract.id,
        period: new Date("2026-09-01T00:00:00Z"), concept: "alquiler" } },
      update: {},
      create: { tenantId: tenant.id, contractId: financeContract.id, createdById: admin.id,
        period: new Date("2026-09-01T00:00:00Z"), dueDate: new Date("2026-09-10T00:00:00Z"),
        amount: financeContract.monthlyRent, currency: "ARS", concept: "alquiler" }
    });
    const fullPaymentKey = `00000000-0000-4000-8000-00000000001${suffix}`;
    await prisma.rentalPayment.upsert({
      where: { tenantId_idempotencyKey: { tenantId: tenant.id, idempotencyKey: fullPaymentKey } },
      update: {},
      create: { tenantId: tenant.id, chargeId: settledCharge.id, createdById: admin.id,
        idempotencyKey: fullPaymentKey, amount: financeContract.monthlyRent,
        paidAt: new Date("2026-09-10T00:00:00Z"), method: "transferencia",
        reference: `DEMO-${suffix.toUpperCase()}-COMPLETO`, note: "Cobro ficticio completo" }
    });
    await prisma.rentalAdjustment.upsert({
      where: { contractId_effectivePeriod: { contractId: financeContract.id,
        effectivePeriod: new Date("2026-11-01T00:00:00Z") } },
      update: {},
      create: { tenantId: tenant.id, contractId: financeContract.id, createdById: admin.id,
        effectivePeriod: new Date("2026-11-01T00:00:00Z"),
        amount: index === 0 ? "420000.00" : "510000.00",
        reason: "Ajuste ficticio para probar cargos futuros" }
    });
    const existingSettlement = await prisma.rentalSettlement.findFirst({
      where: { chargeId: settledCharge.id, status: { not: "cancelada" } }
    });
    if (!existingSettlement) await prisma.rentalSettlement.create({ data: {
      tenantId: tenant.id, contractId: financeContract.id, chargeId: settledCharge.id,
      createdById: admin.id, gross: financeContract.monthlyRent,
      commission: index === 0 ? "19000.00" : "23000.00",
      expenses: index === 0 ? "5000.00" : "7000.00",
      net: index === 0 ? "356000.00" : "430000.00", currency: "ARS",
      status: index === 0 ? "pagada" : "preparada",
      note: "Liquidación ficticia del seed local",
      ...(index === 0 ? { paidAt: new Date("2026-09-12T00:00:00Z"),
        paymentMethod: "transferencia", paymentReference: "DEMO-A-DUENO-001", paidById: admin.id } : {})
    } });
    const demoMaintenance = await prisma.maintenanceRequest.findFirst({
      where: { tenantId: tenant.id, propertyId: rentalProperty.id, title: `Revisión de canilla demo ${suffix.toUpperCase()}` }
    });
    if (!demoMaintenance) {
      const item = await prisma.maintenanceRequest.create({ data: {
        tenantId: tenant.id, propertyId: rentalProperty.id, contractId: demoContract.id,
        createdById: admin.id, title: `Revisión de canilla demo ${suffix.toUpperCase()}`,
        description: "La canilla de la cocina pierde agua. Caso ficticio para probar mantenimiento.",
        priority: "normal"
      } });
      await prisma.maintenanceEvent.create({ data: { tenantId: tenant.id, requestId: item.id,
        actorId: admin.id, toState: "abierta", note: "Reporte ficticio del seed local" } });
    }

    for (const service of [
      { type: "luz" as const, provider: "Energía Demo", accountNumber: `LUZ-${suffix.toUpperCase()}-100`, visibility: "ambos" as const },
      { type: "agua" as const, provider: "Aguas Demo", accountNumber: `AGUA-${suffix.toUpperCase()}-200`, visibility: "ambos" as const }
    ]) {
      const existing = await prisma.rentalServiceAccount.findFirst({
        where: { tenantId: tenant.id, propertyId: rentalProperty.id, type: service.type,
          accountNumber: service.accountNumber }
      });
      if (!existing) await prisma.rentalServiceAccount.create({ data: {
        tenantId: tenant.id, propertyId: rentalProperty.id, createdById: admin.id, ...service
      } });
    }

    const scenarios = [
      { ref: "nueva", estado: "nueva" as const, nombre: `Consulta nueva demo ${suffix.toUpperCase()}`,
        mensaje: "Quiero conocer el departamento de prueba" },
      { ref: "en-contacto", estado: "en_contacto" as const, nombre: `Consulta en contacto demo ${suffix.toUpperCase()}`,
        mensaje: "Solicito coordinar una visita" },
      { ref: "ganada", estado: "ganada" as const, nombre: `Consulta ganada demo ${suffix.toUpperCase()}`,
        mensaje: "Se acordó continuar con el alquiler" },
      { ref: "perdida", estado: "perdida" as const, nombre: `Consulta perdida demo ${suffix.toUpperCase()}`,
        mensaje: "El interesado eligió otra opción" }
    ];
    for (const lead of scenarios) {
      const canalRef = `seed-demo-${suffix}-${lead.ref}`;
      const existing = await prisma.lead.findFirst({ where: { tenantId: tenant.id, canalRef } });
      if (existing) continue;
      const created = await prisma.lead.create({ data: {
        tenantId: tenant.id, propertyId: rentalProperty.id, assignedTo: agentId,
        canal: "manual", canalRef, nombre: lead.nombre, mensaje: lead.mensaje,
        email: `${lead.ref}@consulta-demo-${suffix}.test`, estado: lead.estado
      } });
      if (lead.estado === "ganada") await prisma.leadStatusHistory.create({ data: {
        tenantId: tenant.id, leadId: created.id, actorId: admin.id,
        fromState: "en_contacto", toState: "ganada", operation: "alquiler",
        note: "Cierre ficticio del seed local"
      } });
      if (lead.estado === "perdida") await prisma.leadStatusHistory.create({ data: {
        tenantId: tenant.id, leadId: created.id, actorId: admin.id,
        fromState: "en_contacto", toState: "perdida", reason: "eligio_otra",
        note: "Cierre ficticio del seed local"
      } });
    }

    await seedClients(prisma, tenant.id, admin.id, suffix);

    for (const [tipo, titulo] of [
      ["error", `Reporte de prueba ${suffix.toUpperCase()}`],
      ["sugerencia", `Sugerencia de prueba ${suffix.toUpperCase()}`]
    ] as const) {
      const existing = await prisma.feedbackItem.findFirst({ where: { tenantId: tenant.id, titulo } });
      if (!existing) await prisma.feedbackItem.create({ data: {
        tenantId: tenant.id, autorId: agentId, tipo, titulo,
        descripcion: `Feedback ficticio de tipo ${tipo} para revisar el circuito del panel.`
      } });
    }
  }

  console.log("Seed local Lokation OK: dos inmobiliarias con personal, propietarios, inquilinos, portales, propiedades, contratos, PDF privado, consultas, mantenimiento, cobros, ajustes y liquidaciones.");
  console.log(`Contraseña local de demostración: ${DEV_PASSWORD}`);
}

main().finally(() => prisma.$disconnect());
