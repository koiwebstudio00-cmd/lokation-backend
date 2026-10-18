import type { PrismaClient } from "@prisma/client";

// Adición idempotente: conserva las personas, contratos y operaciones previos.
export async function seedClients(prisma: PrismaClient, tenantId: string, adminId: string, suffix: string) {
  const property = await prisma.property.findFirstOrThrow({ where: { tenantId, operacion: "venta" } });
  const people = [];
  for (const role of ["comprador", "vendedor"] as const) {
    const email = `${role}@clientes-demo-${suffix}.test`;
    const existing = await prisma.rentalPerson.findFirst({ where: { tenantId, email } });
    const person = existing ?? await prisma.rentalPerson.create({ data: { tenantId, createdById: adminId,
      nombre: `${role === "comprador" ? "Comprador" : "Vendedor"} Demo ${suffix.toUpperCase()}`, email,
      roles: role === "vendedor" ? ["vendedor", "propietario"] : ["comprador"] } });
    people.push(person);
  }
  const canalRef = `seed-client-sale-${suffix}`;
  const lead = await prisma.lead.findFirst({ where: { tenantId, canalRef } }) ?? await prisma.lead.create({ data: {
    tenantId, propertyId: property.id, canal: "manual", canalRef, nombre: `Compra de vivienda demo ${suffix.toUpperCase()}`,
    email: people[0].email, mensaje: "Operación ficticia de compra para verificar clientes vinculados.", estado: "en_contacto"
  } });
  await prisma.clientOperation.createMany({ data: people.map((person) => ({ personId: person.id, leadId: lead.id, tenantId })), skipDuplicates: true });
}
