import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  type HarnessProfileDraftManifestV1,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import {
  harnessProfiles,
  harnessProfileVersions,
  harnessSkillArtifacts,
  organization,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  compileHarnessProfileManifest,
  hashHarnessProfileManifest,
} from "./manifest.js";
import { getHarnessProfileDetail } from "./store.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values({
    id: "org-detail",
    name: "Profile detail",
    slug: "profile-detail",
  });
});

function baseDraft(): HarnessProfileDraftManifestV1 {
  const {
    profileId: _profileId,
    version: _version,
    slug: _slug,
    system: _system,
    ...draft
  } = structuredClone(
    BUILTIN_HARNESS_PROFILE_MANIFESTS[
      BUILTIN_HARNESS_PROFILE_IDS.codex
    ],
  );
  return draft;
}

describe("Harness Profile detail", () => {
  it("includes an exact old workflow pin beyond the 50-version history page", async () => {
    const profileId = "profile-many-versions";
    const draft = baseDraft();
    draft.instructions = "Version 51";
    await db.insert(harnessProfiles).values({
      id: profileId,
      organizationId: "org-detail",
      slug: "many-versions",
      draftManifest: draft,
      draftRevision: 51,
      publishedVersion: null,
      createdById: "owner",
      updatedById: "owner",
    });

    const versions = Array.from({ length: 51 }, (_, index) => {
      const version = index + 1;
      const versionDraft = baseDraft();
      versionDraft.instructions = `Version ${version}`;
      const manifest = compileHarnessProfileManifest({
        profileId,
        version,
        slug: "many-versions",
        system: false,
        draft: versionDraft,
      });
      return {
        profileId,
        version,
        manifest,
        manifestHash: hashHarnessProfileManifest(manifest),
        createdById: "owner",
      };
    });
    await db.insert(harnessProfileVersions).values(versions);
    await db
      .update(harnessProfiles)
      .set({ publishedVersion: 51 })
      .where(eq(harnessProfiles.id, profileId));

    const detail = await getHarnessProfileDetail(db, {
      organizationId: "org-detail",
      profileId,
      actorRole: "owner",
      requestedVersion: 1,
    });

    expect(detail?.published?.version).toBe(51);
    expect(detail?.versions).toHaveLength(51);
    expect(detail?.versions.some((version) => version.version === 1)).toBe(
      true,
    );
  });

  it("carries the source of every pinned skill without changing the manifest", async () => {
    const githubHash = "a".repeat(64);
    const localHash = "b".repeat(64);
    const danglingHash = "c".repeat(64);
    await db.insert(harnessSkillArtifacts).values([
      {
        organizationId: "org-detail",
        artifactHash: githubHash,
        name: "from-github",
        sourceKind: "github",
        sourceOwner: "blazity",
        sourceRepository: "ai-workflow",
        sourcePath: "skills/review",
        sourceCommitSha: "d".repeat(40),
        createdById: "owner",
      },
      {
        organizationId: "org-detail",
        artifactHash: localHash,
        name: "from-deployment",
        sourceKind: "local",
        localPath: "review-checklist",
        localContentSha256: "e".repeat(64),
        createdById: "owner",
      },
    ]);

    const draft = baseDraft();
    draft.skills = [
      { artifactHash: githubHash, name: "from-github" },
      { artifactHash: localHash, name: "from-deployment" },
      { artifactHash: danglingHash, name: "gone" },
    ];
    await db.insert(harnessProfiles).values({
      id: "profile-skill-sources",
      organizationId: "org-detail",
      slug: "skill-sources",
      draftManifest: draft,
      draftRevision: 1,
      publishedVersion: null,
      createdById: "owner",
      updatedById: "owner",
    });

    const detail = await getHarnessProfileDetail(db, {
      organizationId: "org-detail",
      profileId: "profile-skill-sources",
      actorRole: "owner",
    });

    expect(
      [...(detail?.skillSources ?? [])].sort((left, right) =>
        left.artifactHash.localeCompare(right.artifactHash),
      ),
    ).toEqual([
      {
        artifactHash: githubHash,
        source: {
          owner: "blazity",
          repository: "ai-workflow",
          path: "skills/review",
          commitSha: "d".repeat(40),
        },
      },
      {
        artifactHash: localHash,
        source: { path: "review-checklist", contentSha256: "e".repeat(64) },
      },
    ]);
    expect(detail?.profile.draft.skills).toEqual(draft.skills);
  });
});
