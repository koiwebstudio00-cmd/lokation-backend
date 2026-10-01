// Utilidades de test: cliente privilegiado (dev0) para preparar datos,
// bypassa RLS a propósito. La app bajo test usa app_rt (ver setup.ts).
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

export const DB_AVAILABLE = Boolean(process.env.DATABASE_URL_TEST);

let _admin: PrismaClient | null = null;

export function adminDb(): PrismaClient {
  _admin ??= new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL_TEST! } }
  });
  return _admin;
}

export async function truncateAll() {
  await adminDb().$executeRawUnsafe(
    `truncate platform_audit, auth_challenges, tenants, users, invitations, refresh_tokens, password_resets,
     properties, property_images, leads, lead_notes, webhook_endpoints,
     webhook_deliveries, api_keys, conversations, conversation_messages,
     vendedores_agente, handoffs, channel_accounts, channel_webhook_events,
     outbound_message_attempts
     restart identity cascade`
  );
}

export const TEST_PASSWORD = "password123";

export async function seedTenantWithUsers(slug: string) {
  const db = adminDb();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const tenant = await db.tenant.create({
    data: { nombre: `Inmo ${slug}`, slug }
  });
  const admin = await db.user.create({
    data: {
      nombre: `Admin ${slug}`,
      email: `admin@${slug}.test`,
      passwordHash,
      rol: "admin",
      tenantId: tenant.id
    }
  });
  const agente = await db.user.create({
    data: {
      nombre: `Agente ${slug}`,
      email: `agente@${slug}.test`,
      passwordHash,
      rol: "agente",
      tenantId: tenant.id
    }
  });
  return { tenant, admin, agente };
}

export async function seedSuperAdmin() {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  return adminDb().user.create({
    data: {
      nombre: "Super Test",
      email: "super@test.test",
      passwordHash,
      rol: "super_admin"
    }
  });
}
