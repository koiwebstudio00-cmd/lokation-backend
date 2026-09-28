import type { Tx } from "../../lib/prisma.js";

/** Incorpora al reparto los vendedores activos que todavía no tienen fila. */
export async function syncActiveSellers(tx: Tx, tenantId: string) {
  const users = await tx.user.findMany({
    where: { tenantId, rol: "agente", estado: "activo" },
    select: { id: true }
  });
  if (users.length === 0) return;
  await tx.vendedorAgente.createMany({
    data: users.map((user) => ({ userId: user.id, tenantId })),
    skipDuplicates: true
  });
}

/**
 * Elige al vendedor disponible que hace más tiempo no recibe una consulta. El
 * join con users evita asignar a una cuenta inactiva aunque su fila histórica
 * de vendedores_agente siga marcada activa.
 */
export async function chooseSeller(
  tx: Tx,
  tenantId: string,
  exclude: string[] = []
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ user_id: string }[]>`
    select va.user_id
    from vendedores_agente va
    join users u on u.id = va.user_id
    where va.activo
      and va.tenant_id = ${tenantId}::uuid
      and u.tenant_id = ${tenantId}::uuid
      and u.rol = 'agente'
      and u.estado = 'activo'
      and va.user_id <> all(${exclude}::uuid[])
    order by va.ultimo_asignado_at asc nulls first,
             va.leads_asignados_count asc,
             random()
    limit 1
    for update of va skip locked
  `;
  return rows[0]?.user_id ?? null;
}

export function markAssigned(tx: Tx, userId: string) {
  return tx.vendedorAgente.update({
    where: { userId },
    data: { ultimoAsignadoAt: new Date(), leadsAsignadosCount: { increment: 1 } }
  });
}
