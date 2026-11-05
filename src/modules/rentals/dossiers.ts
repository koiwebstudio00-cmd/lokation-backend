import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { runWithContext } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
export const rentalDossierRoutes = Router();
rentalDossierRoutes.use("/rental-contracts", requireAuth, requireRole("admin"));
const uuid = z.string().uuid();
const personSelect = { id: true, nombre: true, email: true, telefono: true } as const;
rentalDossierRoutes.get("/rental-contracts/:id/dossier", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const data = await runWithContext(req.auth!, async tx => {
    const contract = await tx.rentalContract.findUnique({ where: { id }, select: {
      tenantPerson: { select: personSelect }, guarantors: { include: { person: { select: personSelect } }, orderBy: { createdAt: "asc" } }
    } });
    if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
    return { tenant: contract.tenantPerson, guarantors: contract.guarantors.map(g => g.person) };
  });
  res.json(data);
});
rentalDossierRoutes.post("/rental-contracts/:id/guarantors", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { personId } = z.object({ personId: uuid }).strict().parse(req.body);
  await runWithContext(req.auth!, async tx => {
    await tx.$queryRaw`SELECT id FROM rental_contracts WHERE id = ${id}::uuid FOR UPDATE`;
    const contract = await tx.rentalContract.findUnique({ where: { id } });
    if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
    if (contract.status === "finalizado") throw new ApiError("CONFLICT", "El contrato está finalizado.");
    const person = await tx.rentalPerson.findUnique({ where: { id: personId } });
    if (!person?.roles.includes("garante") || personId === contract.tenantPersonId) throw new ApiError("VALIDATION_ERROR", "Seleccioná un cliente con rol garante distinto del inquilino.");
    await tx.rentalGuarantor.createMany({ data: [{ contractId: id, personId, tenantId: req.auth!.tenantId! }], skipDuplicates: true });
  });
  res.status(201).json({ ok: true });
});
rentalDossierRoutes.delete("/rental-contracts/:id/guarantors/:personId", async (req, res) => {
  const id = uuid.parse(req.params.id), personId = uuid.parse(req.params.personId);
  await runWithContext(req.auth!, async tx => {
    await tx.$queryRaw`SELECT id FROM rental_contracts WHERE id = ${id}::uuid FOR UPDATE`;
    const contract = await tx.rentalContract.findUnique({ where: { id } });
    if (!contract) throw new ApiError("NOT_FOUND", "El contrato no existe.");
    if (contract.status === "finalizado") throw new ApiError("CONFLICT", "El contrato está finalizado.");
    if (await tx.rentalDocument.count({ where: { contractId: id, personId } })) throw new ApiError("CONFLICT", "El garante tiene documentación vinculada. Conservá el vínculo mientras exista su legajo.");
    await tx.rentalGuarantor.deleteMany({ where: { contractId: id, personId } });
  });
  res.json({ ok: true });
});
