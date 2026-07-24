import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  type HarnessProfileDraftManifestV1,
  type HarnessProfileManifestV1,
  type HarnessProfileReference,
  type HarnessProfileResolvedVersion,
  type HarnessProvider,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import {
  harnessProfiles,
  harnessProfileVersions,
} from "../db/schema.js";
import {
  canManageHarnessProfiles,
  type DashboardRole,
} from "../lib/auth/roles.js";
import {
  compileHarnessProfileManifest,
  hashHarnessProfileManifest,
} from "../harness-profiles/manifest.js";

export interface MigratedHarnessProfilePlan {
  organizationId: string;
  provider: HarnessProvider;
  modelId: string;
  reference: HarnessProfileReference;
  slug: string;
  draft: HarnessProfileDraftManifestV1;
  manifest: HarnessProfileManifestV1;
  manifestHash: string;
}

export function planMigratedHarnessProfile(input: {
  organizationId: string;
  provider: HarnessProvider;
  modelId: string;
}): MigratedHarnessProfilePlan {
  const base =
    input.provider === "claude"
      ? BUILTIN_HARNESS_PROFILE_MANIFESTS["builtin-claude"]
      : BUILTIN_HARNESS_PROFILE_MANIFESTS["builtin-codex"];
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        organizationId: input.organizationId,
        provider: input.provider,
        modelId: input.modelId,
        compatibilityManifestHash: hashHarnessProfileManifest(base),
      }),
    )
    .digest("hex");
  const profileId = `migration-${digest.slice(0, 32)}`;
  const slug = `migrated-${input.provider}-${digest.slice(0, 16)}`;
  const {
    profileId: _profileId,
    version: _version,
    slug: _slug,
    system: _system,
    ...baseDraft
  } = structuredClone(base);
  const providerName = input.provider === "codex" ? "Codex" : "Claude";
  const draft: HarnessProfileDraftManifestV1 = {
    ...baseDraft,
    displayName: `${providerName} · ${input.modelId}`,
    description:
      "Automatically created to preserve a v1 workflow agent configuration.",
    model: { id: input.modelId, options: {} },
  };
  const manifest = compileHarnessProfileManifest({
    profileId,
    version: 1,
    slug,
    system: false,
    draft,
  });
  return {
    organizationId: input.organizationId,
    provider: input.provider,
    modelId: input.modelId,
    reference: { profileId, version: 1 },
    slug,
    draft,
    manifest,
    manifestHash: hashHarnessProfileManifest(manifest),
  };
}

export function resolvedMigratedHarnessProfile(
  plan: MigratedHarnessProfilePlan,
): HarnessProfileResolvedVersion {
  return {
    manifest: structuredClone(plan.manifest),
    manifestHash: plan.manifestHash,
    skillArtifacts: [],
  };
}

export async function ensureMigratedHarnessProfiles(
  db: Db,
  input: {
    plans: readonly MigratedHarnessProfilePlan[];
    actor: {
      organizationId: string;
      role: DashboardRole;
      id: string;
    };
  },
): Promise<void> {
  if (input.plans.length === 0) return;
  if (!canManageHarnessProfiles(input.actor.role)) {
    throw new Error("Only owners and admins can create migration profiles.");
  }
  for (const plan of input.plans) {
    if (plan.organizationId !== input.actor.organizationId) {
      throw new Error("Migration profile belongs to another organization.");
    }
    await db
      .insert(harnessProfiles)
      .values({
        id: plan.reference.profileId,
        organizationId: plan.organizationId,
        slug: plan.slug,
        draftManifest: plan.draft,
        draftRevision: 1,
        publishedVersion: null,
        system: false,
        readOnly: false,
        createdById: input.actor.id,
        updatedById: input.actor.id,
      })
      .onConflictDoNothing({ target: harnessProfiles.id });

    const [profile] = await db
      .select()
      .from(harnessProfiles)
      .where(
        and(
          eq(harnessProfiles.id, plan.reference.profileId),
          eq(harnessProfiles.organizationId, plan.organizationId),
        ),
      )
      .limit(1);
    if (
      !profile ||
      profile.system ||
      profile.readOnly ||
      profile.archivedAt !== null ||
      profile.slug !== plan.slug ||
      !isDeepStrictEqual(profile.draftManifest, plan.draft) ||
      (profile.publishedVersion !== null &&
        profile.publishedVersion !== plan.reference.version)
    ) {
      throw new Error(
        `Migration Harness Profile "${plan.reference.profileId}" conflicts with existing data.`,
      );
    }

    await db
      .insert(harnessProfileVersions)
      .values({
        profileId: plan.reference.profileId,
        version: plan.reference.version,
        manifest: plan.manifest,
        manifestHash: plan.manifestHash,
        createdById: input.actor.id,
      })
      .onConflictDoNothing();
    const [version] = await db
      .select()
      .from(harnessProfileVersions)
      .where(
        and(
          eq(harnessProfileVersions.profileId, plan.reference.profileId),
          eq(harnessProfileVersions.version, plan.reference.version),
        ),
      )
      .limit(1);
    if (
      !version ||
      version.manifestHash !== plan.manifestHash ||
      !isDeepStrictEqual(version.manifest, plan.manifest)
    ) {
      throw new Error(
        `Migration Harness Profile "${plan.reference.profileId}" has a conflicting immutable version.`,
      );
    }

    if (profile.publishedVersion === null) {
      await db
        .update(harnessProfiles)
        .set({
          publishedVersion: plan.reference.version,
          updatedAt: new Date(),
          updatedById: input.actor.id,
        })
        .where(
          and(
            eq(harnessProfiles.id, plan.reference.profileId),
            eq(harnessProfiles.organizationId, plan.organizationId),
          ),
        );
    }
  }
}
