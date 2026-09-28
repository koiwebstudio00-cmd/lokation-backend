import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptZernioAccount } from "../src/modules/integrations/channel-adoption.service.js";
import { adminDb, DB_AVAILABLE, seedTenantWithUsers, truncateAll } from "./helpers.js";

const PROFILE_ID = "profile_coexistence";
const ACCOUNT_ID = "account_coexistence";

function mockZernio(opts: { active?: boolean; healthy?: boolean } = {}) {
  const active = opts.active ?? true;
  const healthy = opts.healthy ?? true;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/api/v1/profiles") {
        return Response.json({ profiles: [{ _id: PROFILE_ID, name: "lamelas" }] });
      }
      if (url.pathname === "/api/v1/accounts") {
        expect(url.searchParams.get("profileId")).toBe(PROFILE_ID);
        expect(url.searchParams.get("platform")).toBe("whatsapp");
        return Response.json({
          accounts: [
            {
              _id: ACCOUNT_ID,
              platform: "whatsapp",
              username: "+5493810000947",
              displayName: "Lamelas",
              isActive: active
            }
          ]
        });
      }
      if (url.pathname === `/api/v1/accounts/${ACCOUNT_ID}/health`) {
        return Response.json({
          status: healthy ? "healthy" : "error",
          issues: healthy ? [] : ["reconnect_required"],
          platformConnection: { status: healthy ? "connected" : "disconnected" }
        });
      }
      throw new Error(`Request inesperado a ${url.toString()}`);
    })
  );
}

describe.runIf(DB_AVAILABLE)("Zernio: adopción administrativa", () => {
  beforeEach(async () => {
    await truncateAll();
    mockZernio();
  });

  afterEach(() => vi.unstubAllGlobals());

  async function seedWithHistoricalChannel(slug = "adopt") {
    const seeded = await seedTenantWithUsers(slug);
    await adminDb().tenant.update({
      where: { id: seeded.tenant.id },
      data: { zernioProfileId: "profile_previous" }
    });
    const historical = await adminDb().channelAccount.create({
      data: {
        tenantId: seeded.tenant.id,
        canal: "whatsapp",
        zernioProfileId: "profile_previous",
        zernioAccountId: "account_previous",
        displayPhone: "+5493811111111",
        estado: "desconectada",
        disconnectedAt: new Date()
      }
    });
    return { ...seeded, historical };
  }

  it("el dry-run valida Zernio y no escribe en la base", async () => {
    const seeded = await seedWithHistoricalChannel();

    const result = await adoptZernioAccount(adminDb(), {
      tenantSlug: seeded.tenant.slug,
      profileId: PROFILE_ID,
      accountId: ACCOUNT_ID,
      mode: "coexistence"
    });

    expect(result.applied).toBe(false);
    expect(result.tenant.profileReplacementRequired).toBe(true);
    expect(result.account.health).toBe("healthy");
    expect(result.previousChannels).toHaveLength(1);
    expect(
      (await adminDb().tenant.findUniqueOrThrow({ where: { id: seeded.tenant.id } }))
        .zernioProfileId
    ).toBe("profile_previous");
    expect(await adminDb().channelAccount.count({ where: { tenantId: seeded.tenant.id } })).toBe(1);
  });

  it("aplica el reemplazo explícito y conserva la cuenta histórica", async () => {
    const seeded = await seedWithHistoricalChannel();
    const dryRun = await adoptZernioAccount(adminDb(), {
      tenantSlug: seeded.tenant.slug,
      profileId: PROFILE_ID,
      accountId: ACCOUNT_ID,
      mode: "coexistence"
    });

    const result = await adoptZernioAccount(adminDb(), {
      tenantSlug: seeded.tenant.slug,
      profileId: PROFILE_ID,
      accountId: ACCOUNT_ID,
      mode: "coexistence",
      apply: true,
      replaceProfileId: "profile_previous",
      confirmation: dryRun.confirmationRequired
    });

    expect(result.applied).toBe(true);
    expect(
      (await adminDb().tenant.findUniqueOrThrow({ where: { id: seeded.tenant.id } }))
        .zernioProfileId
    ).toBe(PROFILE_ID);

    const channels = await adminDb().channelAccount.findMany({
      where: { tenantId: seeded.tenant.id },
      orderBy: { createdAt: "asc" }
    });
    expect(channels).toHaveLength(2);
    expect(channels[0]).toMatchObject({
      id: seeded.historical.id,
      estado: "desconectada",
      zernioAccountId: "account_previous"
    });
    expect(channels[1]).toMatchObject({
      estado: "activa",
      zernioAccountId: ACCOUNT_ID,
      zernioProfileId: PROFILE_ID,
      connectionMode: "coexistence",
      disconnectedAt: null,
      displayPhone: "+5493810000947"
    });
  });

  it("es idempotente si la misma cuenta ya está adoptada", async () => {
    const seeded = await seedWithHistoricalChannel();
    const input = {
      tenantSlug: seeded.tenant.slug,
      profileId: PROFILE_ID,
      accountId: ACCOUNT_ID,
      mode: "coexistence" as const,
      apply: true,
      replaceProfileId: "profile_previous",
      confirmation: `${seeded.tenant.slug}:${ACCOUNT_ID.slice(-8)}`
    };
    await adoptZernioAccount(adminDb(), input);

    const second = await adoptZernioAccount(adminDb(), {
      ...input,
      replaceProfileId: undefined
    });

    expect(second.applied).toBe(false);
    expect(second.alreadyAdopted).toBe(true);
    expect(await adminDb().channelAccount.count({ where: { tenantId: seeded.tenant.id } })).toBe(2);
  });

  it("rechaza una cuenta que ya pertenece a otro tenant", async () => {
    const target = await seedWithHistoricalChannel("adopt-target");
    const owner = await seedTenantWithUsers("adopt-owner");
    await adminDb().channelAccount.create({
      data: {
        tenantId: owner.tenant.id,
        canal: "whatsapp",
        zernioProfileId: PROFILE_ID,
        zernioAccountId: ACCOUNT_ID,
        estado: "activa",
        connectionMode: "coexistence"
      }
    });

    await expect(
      adoptZernioAccount(adminDb(), {
        tenantSlug: target.tenant.slug,
        profileId: PROFILE_ID,
        accountId: ACCOUNT_ID,
        mode: "coexistence"
      })
    ).rejects.toThrow("ya está vinculada a otro tenant");
  });

  it("rechaza si el tenant tiene otra cuenta WhatsApp activa", async () => {
    const seeded = await seedTenantWithUsers("adopt-active");
    await adminDb().channelAccount.create({
      data: {
        tenantId: seeded.tenant.id,
        canal: "whatsapp",
        zernioProfileId: "profile_other",
        zernioAccountId: "account_other",
        estado: "activa"
      }
    });

    await expect(
      adoptZernioAccount(adminDb(), {
        tenantSlug: seeded.tenant.slug,
        profileId: PROFILE_ID,
        accountId: ACCOUNT_ID,
        mode: "coexistence"
      })
    ).rejects.toThrow("otra cuenta WhatsApp activa");
  });

  it("rechaza una cuenta cuyo health no está conectado", async () => {
    vi.unstubAllGlobals();
    mockZernio({ healthy: false });
    const seeded = await seedWithHistoricalChannel("adopt-health");

    await expect(
      adoptZernioAccount(adminDb(), {
        tenantSlug: seeded.tenant.slug,
        profileId: PROFILE_ID,
        accountId: ACCOUNT_ID,
        mode: "coexistence"
      })
    ).rejects.toThrow("no está operativa");
  });

  it("rechaza una cuenta inactiva aunque figure en el profile", async () => {
    vi.unstubAllGlobals();
    mockZernio({ active: false });
    const seeded = await seedWithHistoricalChannel("adopt-inactive");

    await expect(
      adoptZernioAccount(adminDb(), {
        tenantSlug: seeded.tenant.slug,
        profileId: PROFILE_ID,
        accountId: ACCOUNT_ID,
        mode: "coexistence"
      })
    ).rejects.toThrow("no está activa");
  });

  it("rechaza un profile que no existe en el team de Zernio", async () => {
    const seeded = await seedWithHistoricalChannel("adopt-profile");

    await expect(
      adoptZernioAccount(adminDb(), {
        tenantSlug: seeded.tenant.slug,
        profileId: "profile_missing",
        accountId: ACCOUNT_ID,
        mode: "coexistence"
      })
    ).rejects.toThrow("no encontró el profile");
  });
});
