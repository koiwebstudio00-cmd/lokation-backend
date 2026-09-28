// Tests de aislamiento del contexto interno 'agent' — regla 1 del CLAUDE.md.
// El agente de IA escribe en el CRM con una API key: hay que probar que ese
// contexto no puede salirse del tenant de su key, y que lo que sí necesita
// (leer propiedades y vendedores, escribir leads y conversaciones) funciona.
//
// Ojo con la homofonía: rol 'agente' = el vendedor (persona); contexto 'agent'
// = el agente de IA (máquina). No comparten permisos.
import { beforeAll, describe, expect, it } from "vitest";
import { runWithContext } from "../src/lib/prisma.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, truncateAll } from "./helpers.js";

describe.runIf(DB_AVAILABLE)("RLS del contexto 'agent'", () => {
  let A: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let B: Awaited<ReturnType<typeof seedTenantWithUsers>>;
  let leadA = "";
  let convA = "";
  let leadB = "";

  const agentA = () => ({ rol: "agent" as const, tenantId: A.tenant.id });
  const agentB = () => ({ rol: "agent" as const, tenantId: B.tenant.id });

  beforeAll(async () => {
    await truncateAll();
    A = await seedTenantWithUsers("agta");
    B = await seedTenantWithUsers("agtb");

    // Un lead de cada tenant, sembrado con el cliente privilegiado.
    const db = adminDb();
    const la = await db.lead.create({
      data: {
        tenantId: A.tenant.id,
        canal: "whatsapp",
        canalRef: "+5493810000001",
        nombre: "Lead A",
        mensaje: "hola"
      }
    });
    leadA = la.id;
    const lb = await db.lead.create({
      data: {
        tenantId: B.tenant.id,
        canal: "whatsapp",
        canalRef: "+5493810000002",
        nombre: "Lead B",
        mensaje: "hola"
      }
    });
    leadB = lb.id;
  });

  it("crea la conversación de su tenant y la vuelve a leer (INSERT + read de Prisma)", async () => {
    const conv = await runWithContext(agentA(), (tx) =>
      tx.conversation.create({
        data: {
          tenantId: A.tenant.id,
          leadId: leadA,
          canal: "whatsapp",
          canalRef: "+5493810000001",
          intencion: "comprar",
          tipoPropiedad: ["departamento"],
          ciudad: "San Miguel de Tucumán",
          zonas: ["Barrio Norte"],
          temperatura: "caliente"
        }
      })
    );
    convA = conv.id;
    expect(conv.estado).toBe("bot");
    expect(conv.intencion).toBe("comprar");
  });

  it("NO puede crear una conversación en otro tenant", async () => {
    await expect(
      runWithContext(agentA(), (tx) =>
        tx.conversation.create({
          data: {
            tenantId: B.tenant.id,
            leadId: leadB,
            canal: "whatsapp",
            canalRef: "+5493810000002"
          }
        })
      )
    ).rejects.toThrow();
  });

  it("el agente del tenant B no ve las conversaciones de A", async () => {
    const desdeB = await runWithContext(agentB(), (tx) => tx.conversation.findMany());
    expect(desdeB).toHaveLength(0);

    const desdeA = await runWithContext(agentA(), (tx) => tx.conversation.findMany());
    expect(desdeA.map((c) => c.id)).toEqual([convA]);
  });

  it("una sola conversación viva por canal_ref (índice único parcial)", async () => {
    await expect(
      runWithContext(agentA(), (tx) =>
        tx.conversation.create({
          data: {
            tenantId: A.tenant.id,
            leadId: leadA,
            canal: "whatsapp",
            canalRef: "+5493810000001"
          }
        })
      )
    ).rejects.toThrow();

    // Cerrada la primera, se puede abrir otra con el mismo número.
    await runWithContext(agentA(), (tx) =>
      tx.conversation.updateMany({ where: { id: convA }, data: { estado: "cerrada" } })
    );
    const nueva = await runWithContext(agentA(), (tx) =>
      tx.conversation.create({
        data: {
          tenantId: A.tenant.id,
          leadId: leadA,
          canal: "whatsapp",
          canalRef: "+5493810000001"
        }
      })
    );
    expect(nueva.id).not.toBe(convA);
    convA = nueva.id;
  });

  it("registra mensajes y los lee; el otro tenant no los ve", async () => {
    await runWithContext(agentA(), (tx) =>
      tx.conversationMessage.create({
        data: {
          tenantId: A.tenant.id,
          conversationId: convA,
          rol: "lead",
          contenido: "quiero ver el depto"
        }
      })
    );
    const msgsA = await runWithContext(agentA(), (tx) => tx.conversationMessage.findMany());
    expect(msgsA).toHaveLength(1);

    const msgsB = await runWithContext(agentB(), (tx) => tx.conversationMessage.findMany());
    expect(msgsB).toHaveLength(0);
  });

  it("da de alta leads de su tenant, pero no de otro", async () => {
    const lead = await runWithContext(agentA(), (tx) =>
      tx.lead.create({
        data: {
          tenantId: A.tenant.id,
          canal: "whatsapp",
          canalRef: "+5493819999999",
          nombre: "Nuevo por WhatsApp",
          mensaje: "consulta"
        }
      })
    );
    expect(lead.canal).toBe("whatsapp");

    await expect(
      runWithContext(agentA(), (tx) =>
        tx.lead.create({
          data: {
            tenantId: B.tenant.id,
            canal: "whatsapp",
            canalRef: "+5493818888888",
            nombre: "Intruso",
            mensaje: "x"
          }
        })
      )
    ).rejects.toThrow();
  });

  it("escribe notas sin usuario (origen 'agente') y no puede firmarlas como humano", async () => {
    const nota = await runWithContext(agentA(), (tx) =>
      tx.leadNote.create({
        data: {
          tenantId: A.tenant.id,
          leadId: leadA,
          origen: "agente",
          nota: "🤖 Resumen del agente — quiere comprar en Barrio Norte"
        }
      })
    );
    expect(nota.userId).toBeNull();

    // Con origen 'humano' y sin user_id lo frena el check de la BD.
    await expect(
      runWithContext(agentA(), (tx) =>
        tx.leadNote.create({
          data: { tenantId: A.tenant.id, leadId: leadA, nota: "sin firmar" }
        })
      )
    ).rejects.toThrow();
  });

  it("lee las propiedades y los vendedores de su tenant, y solo de su tenant", async () => {
    await adminDb().property.create({
      data: {
        tenantId: A.tenant.id,
        userId: A.agente.id,
        titulo: "Depto Barrio Norte",
        operacion: "venta",
        tipo: "departamento",
        precio: 85000
      }
    });

    const props = await runWithContext(agentA(), (tx) => tx.property.findMany());
    expect(props).toHaveLength(1);
    const propsB = await runWithContext(agentB(), (tx) => tx.property.findMany());
    expect(propsB).toHaveLength(0);

    const users = await runWithContext(agentA(), (tx) => tx.user.findMany());
    expect(users.every((u) => u.tenantId === A.tenant.id)).toBe(true);
    expect(users.length).toBeGreaterThan(0);
  });

  it("NO puede tocar usuarios, propiedades ni API keys (solo lectura de contexto)", async () => {
    const { count } = await runWithContext(agentA(), (tx) =>
      tx.user.updateMany({ where: { id: A.agente.id }, data: { estado: "inactivo" } })
    );
    expect(count).toBe(0);

    await expect(
      runWithContext(agentA(), (tx) =>
        tx.property.create({
          data: {
            tenantId: A.tenant.id,
            userId: A.agente.id,
            titulo: "No debería",
            operacion: "venta",
            tipo: "casa",
            precio: 1
          }
        })
      )
    ).rejects.toThrow();

    const keys = await runWithContext(agentA(), (tx) => tx.apiKey.findMany());
    expect(keys).toHaveLength(0);
  });

  it("reparto: elige al vendedor que hace más que no recibe, desempatando al azar", async () => {
    const db = adminDb();
    await db.vendedorAgente.createMany({
      data: [
        { userId: A.admin.id, tenantId: A.tenant.id },
        { userId: A.agente.id, tenantId: A.tenant.id }
      ]
    });
    // El admin ya recibió una; el agente nunca (null va primero).
    await db.vendedorAgente.update({
      where: { userId: A.admin.id },
      data: { ultimoAsignadoAt: new Date() }
    });

    const elegido = await runWithContext(agentA(), (tx) =>
      tx.$queryRaw<{ user_id: string }[]>`
        select user_id from vendedores_agente
        where activo and tenant_id = ${A.tenant.id}::uuid
        order by ultimo_asignado_at asc nulls first, random()
        limit 1
        for update skip locked
      `
    );
    expect(elegido[0].user_id).toBe(A.agente.id);
  });

  it("el vendedor de A no ve la conversación de otro vendedor", async () => {
    const ctxVendedor = {
      userId: A.agente.id,
      tenantId: A.tenant.id,
      rol: "agente" as const
    };
    // La conversación no tiene vendedor asignado y el lead tampoco.
    const vistas = await runWithContext(ctxVendedor, (tx) => tx.conversation.findMany());
    expect(vistas).toHaveLength(0);

    // Asignada, sí la ve.
    await runWithContext(agentA(), (tx) =>
      tx.conversation.updateMany({
        where: { id: convA },
        data: { vendedorId: A.agente.id, estado: "esperando_humano" }
      })
    );
    const ahora = await runWithContext(ctxVendedor, (tx) => tx.conversation.findMany());
    expect(ahora.map((c) => c.id)).toEqual([convA]);
  });

  it("el admin ve todas las conversaciones de su tenant", async () => {
    const ctxAdmin = { userId: A.admin.id, tenantId: A.tenant.id, rol: "admin" as const };
    const todas = await runWithContext(ctxAdmin, (tx) => tx.conversation.findMany());
    expect(todas.length).toBeGreaterThanOrEqual(2);
    expect(todas.every((c) => c.tenantId === A.tenant.id)).toBe(true);
  });
});
