import type { PrismaClient } from "@prisma/client";
import { zernioFetch } from "../../lib/zernio.js";

export const CONNECTION_MODES = ["coexistence", "cloud_api"] as const;
export type ConnectionMode = (typeof CONNECTION_MODES)[number];

interface ZernioProfile {
  _id: string;
  name?: string;
}

interface ZernioAccount {
  _id: string;
  platform: string;
  username?: string;
  displayName?: string;
  isActive?: boolean;
}

interface ZernioHealth {
  status?: string;
  issues?: string[];
  platformConnection?: { status?: string };
}

export interface AdoptionInput {
  tenantSlug: string;
  profileId: string;
  accountId: string;
  mode: ConnectionMode;
  apply?: boolean;
  replaceProfileId?: string;
  confirmation?: string;
}

export interface AdoptionResult {
  applied: boolean;
  alreadyAdopted: boolean;
  confirmationRequired: string;
  tenant: {
    id: string;
    slug: string;
    currentProfileId: string | null;
    targetProfileId: string;
    profileReplacementRequired: boolean;
  };
  account: {
    id: string;
    displayName: string | null;
    displayPhone: string | null;
    mode: ConnectionMode;
    health: string;
  };
  previousChannels: Array<{
    id: string;
    accountId: string;
    profileId: string;
    estado: string;
    displayPhone: string | null;
  }>;
}

function confirmationFor(tenantSlug: string, accountId: string) {
  return `${tenantSlug}:${accountId.slice(-8)}`;
}

function assertApplyConfirmation(input: AdoptionInput, currentProfileId: string | null) {
  const expected = confirmationFor(input.tenantSlug, input.accountId);
  if (input.confirmation !== expected) {
    throw new Error(`Confirmación inválida. Para aplicar usá --confirm ${expected}`);
  }

  if (currentProfileId && currentProfileId !== input.profileId) {
    if (input.replaceProfileId !== currentProfileId) {
      throw new Error(
        `El tenant apunta al profile '${currentProfileId}'. ` +
          `Para reemplazarlo explícitamente usá --replace-profile ${currentProfileId}`
      );
    }
  } else if (input.replaceProfileId) {
    throw new Error("--replace-profile no corresponde: el profile actual ya coincide o está vacío.");
  }
}

async function validateZernioAccount(input: AdoptionInput) {
  const { profiles } = await zernioFetch<{ profiles: ZernioProfile[] }>("/profiles");
  const profile = profiles?.find((item) => item._id === input.profileId);
  if (!profile) throw new Error(`Zernio no encontró el profile '${input.profileId}'.`);

  const { accounts } = await zernioFetch<{ accounts: ZernioAccount[] }>("/accounts", {
    query: { profileId: input.profileId, platform: "whatsapp" }
  });
  const account = accounts?.find((item) => item._id === input.accountId);
  if (!account) {
    throw new Error(
      `La cuenta '${input.accountId}' no pertenece al profile '${input.profileId}'.`
    );
  }
  if (account.platform.toLowerCase() !== "whatsapp") {
    throw new Error(`La cuenta '${input.accountId}' no es de WhatsApp.`);
  }
  if (account.isActive !== true) {
    throw new Error(`La cuenta '${input.accountId}' no está activa en Zernio.`);
  }

  const health = await zernioFetch<ZernioHealth>(`/accounts/${account._id}/health`);
  if (health.status !== "healthy" || health.platformConnection?.status !== "connected") {
    const issues = health.issues?.length ? ` (${health.issues.join(", ")})` : "";
    throw new Error(`La cuenta '${input.accountId}' no está operativa en Zernio${issues}.`);
  }

  return { profile, account, health };
}

/**
 * Adopta una cuenta ya conectada en Zernio. Debe recibir un Prisma privilegiado
 * de operación (DATABASE_URL_MIGRATE); nunca se expone como endpoint público.
 */
export async function adoptZernioAccount(
  db: PrismaClient,
  input: AdoptionInput
): Promise<AdoptionResult> {
  const tenant = await db.tenant.findUnique({
    where: { slug: input.tenantSlug },
    select: { id: true, slug: true, zernioProfileId: true }
  });
  if (!tenant) throw new Error(`No existe el tenant '${input.tenantSlug}'.`);

  const { account } = await validateZernioAccount(input);
  const [accountOwner, activeChannel, previousChannels] = await Promise.all([
    db.channelAccount.findUnique({
      where: { zernioAccountId: input.accountId },
      select: { id: true, tenantId: true, estado: true, connectionMode: true }
    }),
    db.channelAccount.findFirst({
      where: { tenantId: tenant.id, canal: "whatsapp", estado: "activa" },
      select: { id: true, zernioAccountId: true, displayPhone: true }
    }),
    db.channelAccount.findMany({
      where: { tenantId: tenant.id, canal: "whatsapp" },
      select: {
        id: true,
        zernioAccountId: true,
        zernioProfileId: true,
        estado: true,
        displayPhone: true
      },
      orderBy: { createdAt: "desc" }
    })
  ]);

  if (accountOwner && accountOwner.tenantId !== tenant.id) {
    throw new Error("La cuenta de Zernio ya está vinculada a otro tenant.");
  }
  if (activeChannel && activeChannel.zernioAccountId !== input.accountId) {
    throw new Error(
      `El tenant ya tiene otra cuenta WhatsApp activa ` +
        `(${activeChannel.displayPhone ?? activeChannel.zernioAccountId}).`
    );
  }

  const targetAlreadyActive =
    tenant.zernioProfileId === input.profileId &&
    accountOwner?.estado === "activa" &&
    accountOwner.connectionMode === input.mode;
  const expectedConfirmation = confirmationFor(input.tenantSlug, input.accountId);

  const resultBase: AdoptionResult = {
    applied: false,
    alreadyAdopted: targetAlreadyActive,
    confirmationRequired: expectedConfirmation,
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      currentProfileId: tenant.zernioProfileId,
      targetProfileId: input.profileId,
      profileReplacementRequired:
        Boolean(tenant.zernioProfileId) && tenant.zernioProfileId !== input.profileId
    },
    account: {
      id: account._id,
      displayName: account.displayName ?? null,
      displayPhone: account.username ?? null,
      mode: input.mode,
      health: "healthy"
    },
    previousChannels: previousChannels.map((channel) => ({
      id: channel.id,
      accountId: channel.zernioAccountId,
      profileId: channel.zernioProfileId,
      estado: channel.estado,
      displayPhone: channel.displayPhone
    }))
  };

  if (!input.apply || targetAlreadyActive) return resultBase;
  assertApplyConfirmation(input, tenant.zernioProfileId);

  await db.$transaction(async (tx) => {
    const currentTenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      select: { zernioProfileId: true }
    });
    if (currentTenant.zernioProfileId !== tenant.zernioProfileId) {
      throw new Error("El profile del tenant cambió durante la adopción. Volvé a ejecutar el dry-run.");
    }

    const currentOwner = await tx.channelAccount.findUnique({
      where: { zernioAccountId: input.accountId },
      select: { id: true, tenantId: true }
    });
    if (currentOwner && currentOwner.tenantId !== tenant.id) {
      throw new Error("La cuenta de Zernio fue vinculada a otro tenant durante la adopción.");
    }

    const currentActive = await tx.channelAccount.findFirst({
      where: { tenantId: tenant.id, canal: "whatsapp", estado: "activa" },
      select: { zernioAccountId: true }
    });
    if (currentActive && currentActive.zernioAccountId !== input.accountId) {
      throw new Error("Apareció otra cuenta WhatsApp activa. Volvé a ejecutar el dry-run.");
    }

    if (tenant.zernioProfileId !== input.profileId) {
      await tx.tenant.update({
        where: { id: tenant.id },
        data: { zernioProfileId: input.profileId }
      });
    }

    const channelData = {
      zernioProfileId: input.profileId,
      displayName: account.displayName ?? null,
      displayPhone: account.username ?? null,
      estado: "activa",
      connectionMode: input.mode,
      disconnectedAt: null
    };
    if (currentOwner) {
      await tx.channelAccount.update({ where: { id: currentOwner.id }, data: channelData });
    } else {
      await tx.channelAccount.create({
        data: {
          tenantId: tenant.id,
          canal: "whatsapp",
          zernioAccountId: input.accountId,
          ...channelData
        }
      });
    }
  });

  return { ...resultBase, applied: true };
}
