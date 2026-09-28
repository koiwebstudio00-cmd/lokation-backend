import { Prisma, PrismaClient } from "@prisma/client";

// 'auth', 'worker', 'export' y 'agent' son contextos internos (módulo auth,
// worker de webhooks, resolución de API keys y agente de IA): nunca se derivan
// de input del request. Ver migraciones 0002, 0005, 0007 y 0012.
//
// Ojo con la homofonía: 'agente' es el ROL DE PERSONA (el vendedor de la
// inmobiliaria); 'agent' es el CONTEXTO DE MÁQUINA del agente de IA. No son lo
// mismo y no comparten permisos.
export type Rol =
  | "super_admin"
  | "admin"
  | "agente"
  | "public"
  | "auth"
  | "worker"
  | "export"
  | "agent";

export interface RlsContext {
  userId?: string;
  tenantId?: string;
  rol: Rol;
}

export type Tx = Prisma.TransactionClient;

// Inicialización lazy: permite levantar la app (y correr tests que no tocan BD)
// sin cliente generado/BD disponible. El primer uso real lo instancia.
let _prisma: PrismaClient | null = null;

/**
 * Cliente "pelado": SOLO para health check y módulo auth (queries sin contexto,
 * explícitas y justificadas — regla 2 de CLAUDE.md). Todo lo demás usa runWithContext.
 */
export function getPrisma(): PrismaClient {
  _prisma ??= new PrismaClient();
  return _prisma;
}

/**
 * Ejecuta `fn` dentro de una transacción con el contexto RLS seteado
 * (SET LOCAL app.user_id / app.tenant_id / app.rol). Las policies de Postgres
 * son la autorización real — ver docs permisos-rls.md.
 */
export async function runWithContext<T>(
  ctx: RlsContext,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return getPrisma().$transaction(async (tx: Tx) => {
    await tx.$executeRaw`
      select
        set_config('app.user_id', ${ctx.userId ?? ""}, true),
        set_config('app.tenant_id', ${ctx.tenantId ?? ""}, true),
        set_config('app.rol', ${ctx.rol}, true)
    `;
    return fn(tx);
  });
}
