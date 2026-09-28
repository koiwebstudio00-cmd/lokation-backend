import type { PrismaClient } from "@prisma/client";
import {
  adoptZernioAccount,
  CONNECTION_MODES,
  type ConnectionMode
} from "./channel-adoption.service.js";

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name]?.trim();
  if (!value || value === "true") throw new Error(`Falta --${name}`);
  return value;
}

function optionalFlag(flags: Record<string, string>, name: string): string | undefined {
  const value = flags[name]?.trim();
  return value && value !== "true" ? value : undefined;
}

function shortId(value: string | null): string {
  if (!value) return "—";
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export async function runZernioAdoptCli(
  db: PrismaClient,
  flags: Record<string, string>
): Promise<void> {
  const mode = requireFlag(flags, "mode");
  if (!CONNECTION_MODES.includes(mode as ConnectionMode)) {
    throw new Error("--mode debe ser 'coexistence' o 'cloud_api'.");
  }

  const result = await adoptZernioAccount(db, {
    tenantSlug: requireFlag(flags, "tenant"),
    profileId: requireFlag(flags, "profile"),
    accountId: requireFlag(flags, "account"),
    mode: mode as ConnectionMode,
    apply: flags.apply === "true",
    replaceProfileId: optionalFlag(flags, "replace-profile"),
    confirmation: optionalFlag(flags, "confirm")
  });

  console.log(`\nAdopción Zernio — ${result.applied ? "APLICADA" : "DRY-RUN"}`);
  console.log(`  Tenant:          ${result.tenant.slug}`);
  console.log(`  Profile actual:  ${shortId(result.tenant.currentProfileId)}`);
  console.log(`  Profile destino: ${shortId(result.tenant.targetProfileId)}`);
  console.log(`  Account:         ${shortId(result.account.id)}`);
  console.log(`  Número:          ${result.account.displayPhone ?? "—"}`);
  console.log(`  Nombre:          ${result.account.displayName ?? "—"}`);
  console.log(`  Modo:            ${result.account.mode}`);
  console.log(`  Health:          ${result.account.health}`);
  console.log(`  Históricas:      ${result.previousChannels.length}`);

  if (result.alreadyAdopted) {
    console.log("\nLa cuenta ya estaba adoptada con la misma configuración. No se modificó nada.");
  } else if (!result.applied) {
    console.log("\nNo se modificó nada. Para aplicar:");
    const replace = result.tenant.profileReplacementRequired
      ? ` --replace-profile ${result.tenant.currentProfileId}`
      : "";
    console.log(
      `  repetí el comando con --apply${replace} --confirm ${result.confirmationRequired}`
    );
  }
}
