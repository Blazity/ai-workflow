import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type {
  HarnessProfileDraftManifestV1,
  HarnessProfileManifestV1,
} from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import {
  harnessProfiles,
  harnessProfileVersions,
  harnessProfileVersionSkills,
  harnessSkillArtifactFiles,
  harnessSkillArtifacts,
  organization,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { DashboardAuthError } from "../lib/auth/users-read.js";
import { hashHarnessSkillArtifact } from "./skill-artifact.js";
import {
  archiveHarnessProfile,
  createHarnessProfile,
  ensureSystemHarnessProfiles,
  forkHarnessProfile,
  getHarnessProfile,
  listHarnessProfiles,
  listHarnessProfileVersions,
  publishHarnessProfile,
  resolveHarnessProfileVersion,
  restoreHarnessProfileVersion,
  updateHarnessProfileDraft,
  type HarnessProfileActor,
  type SystemHarnessProfileCatalog,
} from "./store.js";

const ADMIN: HarnessProfileActor = {
  organizationId: "org-a",
  role: "admin",
  id: "admin-a",
};
const MEMBER: HarnessProfileActor = {
  organizationId: "org-a",
  role: "member",
  id: "member-a",
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values([
    { id: "org-a", name: "Organization A", slug: "profile-org-a" },
    { id: "org-b", name: "Organization B", slug: "profile-org-b" },
  ]);
});

function draft(
  provider: "claude" | "codex" = "codex",
): HarnessProfileDraftManifestV1 {
  const manifest =
    BUILTIN_HARNESS_PROFILE_MANIFESTS[
      BUILTIN_HARNESS_PROFILE_IDS[provider]
    ];
  const {
    profileId: _profileId,
    version: _version,
    slug: _slug,
    system: _system,
    ...value
  } = structuredClone(manifest);
  return value;
}

function catalogWithCodex(
  manifest: HarnessProfileManifestV1,
): SystemHarnessProfileCatalog {
  return {
    [BUILTIN_HARNESS_PROFILE_IDS.claude]:
      BUILTIN_HARNESS_PROFILE_MANIFESTS[
        BUILTIN_HARNESS_PROFILE_IDS.claude
      ],
    [BUILTIN_HARNESS_PROFILE_IDS.codex]: manifest,
  };
}

function skillFixture(input?: {
  name?: string;
  commitSha?: string;
  sourcePath?: string;
}) {
  const name = input?.name ?? "review-rules";
  const source = {
    owner: "acme",
    repository: "skills",
    path: input?.sourcePath ?? name,
    commitSha: input?.commitSha ?? "b".repeat(40),
  };
  const description = "Review rules";
  const content = Buffer.from(
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# Rules\n`,
  );
  const files = [
    {
      path: "SKILL.md",
      mode: 0o644,
      sizeBytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      contentBase64: content.toString("base64"),
    },
  ];
  const hashInput = { name, description, source, files };
  return {
    ...hashInput,
    artifactHash: hashHarnessSkillArtifact(hashInput),
  };
}

async function insertSkillFixture(
  input?: Parameters<typeof skillFixture>[0],
) {
  const fixture = skillFixture(input);
  const [artifact] = await db
    .insert(harnessSkillArtifacts)
    .values({
      organizationId: ADMIN.organizationId,
      artifactHash: fixture.artifactHash,
      name: fixture.name,
      description: fixture.description,
      sourceOwner: fixture.source.owner,
      sourceRepository: fixture.source.repository,
      sourcePath: fixture.source.path,
      sourceCommitSha: fixture.source.commitSha,
      createdById: ADMIN.id,
    })
    .returning();
  await db.insert(harnessSkillArtifactFiles).values(
    fixture.files.map((file) => ({
      artifactId: artifact!.id,
      ...file,
    })),
  );
  return { fixture, artifact: artifact! };
}

describe("system profile seeding", () => {
  it("is idempotent and publishes an explicitly versioned catalog update", async () => {
    await ensureSystemHarnessProfiles(db);
    await ensureSystemHarnessProfiles(db);
    let versions = await db.select().from(harnessProfileVersions);
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map((version) => version.profileId))).toEqual(
      new Set(["builtin-claude", "builtin-codex"]),
    );

    const [codexV1] = versions.filter(
      (version) => version.profileId === "builtin-codex",
    );
    const codexV2: HarnessProfileManifestV1 = {
      ...structuredClone(codexV1!.manifest),
      version: 2,
      instructions: "Updated code-owned instructions",
    };

    await ensureSystemHarnessProfiles(db, catalogWithCodex(codexV2));
    versions = await db
      .select()
      .from(harnessProfileVersions)
      .where(eq(harnessProfileVersions.profileId, "builtin-codex"));
    expect(versions.map((version) => version.version).sort()).toEqual([1, 2]);
    const profile = await getHarnessProfile(db, {
      organizationId: "org-a",
      profileId: "builtin-codex",
    });
    expect(profile?.publishedVersion).toBe(2);
    expect(profile?.draftManifest.instructions).toBe(codexV2.instructions);

    await ensureSystemHarnessProfiles(db, catalogWithCodex(codexV2));
    expect(
      await db
        .select()
        .from(harnessProfileVersions)
        .where(eq(harnessProfileVersions.profileId, "builtin-codex")),
    ).toHaveLength(2);
  });

  it("never rolls back or ping-pongs when old and new seeders interleave", async () => {
    const codexV1 =
      BUILTIN_HARNESS_PROFILE_MANIFESTS[
        BUILTIN_HARNESS_PROFILE_IDS.codex
      ];
    const codexV2: HarnessProfileManifestV1 = {
      ...structuredClone(codexV1),
      version: 2,
      instructions: "New binary instructions",
    };
    const oldCatalog = catalogWithCodex(codexV1);
    const newCatalog = catalogWithCodex(codexV2);

    await ensureSystemHarnessProfiles(db, oldCatalog);
    await ensureSystemHarnessProfiles(db, newCatalog);
    await ensureSystemHarnessProfiles(db, oldCatalog);
    await ensureSystemHarnessProfiles(db, newCatalog);
    await Promise.all([
      ensureSystemHarnessProfiles(db, oldCatalog),
      ensureSystemHarnessProfiles(db, newCatalog),
      ensureSystemHarnessProfiles(db, oldCatalog),
      ensureSystemHarnessProfiles(db, newCatalog),
    ]);

    const versions = await db
      .select()
      .from(harnessProfileVersions)
      .where(eq(harnessProfileVersions.profileId, "builtin-codex"));
    expect(versions.map((version) => version.version).sort()).toEqual([1, 2]);
    const profile = await getHarnessProfile(db, {
      organizationId: "org-a",
      profileId: "builtin-codex",
    });
    expect(profile).toMatchObject({
      publishedVersion: 2,
      draftManifest: { instructions: codexV2.instructions },
    });
  });

  it("rejects code-owned content drift without a catalog version bump", async () => {
    await ensureSystemHarnessProfiles(db);
    const codexV1 =
      BUILTIN_HARNESS_PROFILE_MANIFESTS[
        BUILTIN_HARNESS_PROFILE_IDS.codex
      ];
    const driftedV1: HarnessProfileManifestV1 = {
      ...structuredClone(codexV1),
      instructions: "Changed without a version bump",
    };

    await expect(
      ensureSystemHarnessProfiles(db, catalogWithCodex(driftedV1)),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    const profile = await getHarnessProfile(db, {
      organizationId: "org-a",
      profileId: "builtin-codex",
    });
    expect(profile?.publishedVersion).toBe(1);
    expect(profile?.draftManifest.instructions).toBe(codexV1.instructions);
  });
});

describe("organization profiles", () => {
  it("enforces owner/admin writes, tenant scope, and CAS revisions", async () => {
    await expect(
      createHarnessProfile(db, {
        slug: "member-profile",
        draft: draft(),
        actor: MEMBER,
      }),
    ).rejects.toBeInstanceOf(DashboardAuthError);

    const created = await createHarnessProfile(db, {
      slug: "team-profile",
      draft: draft(),
      actor: ADMIN,
    });
    expect(created.draftRevision).toBe(1);
    expect(
      await getHarnessProfile(db, {
        organizationId: "org-b",
        profileId: created.id,
      }),
    ).toBeNull();

    const otherOrg = await createHarnessProfile(db, {
      slug: "team-profile",
      draft: draft(),
      actor: { organizationId: "org-b", role: "owner", id: "owner-b" },
    });
    expect(otherOrg.id).not.toBe(created.id);

    const updatedDraft = draft();
    updatedDraft.instructions = "Organization-specific instructions";
    const updated = await updateHarnessProfileDraft(db, {
      profileId: created.id,
      expectedRevision: 1,
      draft: updatedDraft,
      actor: ADMIN,
    });
    expect(updated.draftRevision).toBe(2);
    await expect(
      updateHarnessProfileDraft(db, {
        profileId: created.id,
        expectedRevision: 1,
        draft: updatedDraft,
        actor: ADMIN,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("publishes immutable versions, restores drafts, forks, and preserves pinned archives", async () => {
    const created = await createHarnessProfile(db, {
      slug: "lifecycle",
      draft: draft(),
      actor: ADMIN,
    });
    const first = await publishHarnessProfile(db, {
      profileId: created.id,
      expectedRevision: 1,
      actor: ADMIN,
    });
    expect(first.changed).toBe(true);
    expect(first.version.version).toBe(1);
    expect(first.version.manifestHash).toMatch(/^[a-f0-9]{64}$/);

    const unchanged = await publishHarnessProfile(db, {
      profileId: created.id,
      expectedRevision: 1,
      actor: ADMIN,
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.version.version).toBe(1);

    const nextDraft = draft();
    nextDraft.instructions = "Version two";
    const changedDraft = await updateHarnessProfileDraft(db, {
      profileId: created.id,
      expectedRevision: 1,
      draft: nextDraft,
      actor: ADMIN,
    });
    const second = await publishHarnessProfile(db, {
      profileId: created.id,
      expectedRevision: changedDraft.draftRevision,
      actor: ADMIN,
    });
    expect(second.version.version).toBe(2);

    const restored = await restoreHarnessProfileVersion(db, {
      profileId: created.id,
      version: 1,
      expectedRevision: changedDraft.draftRevision,
      actor: ADMIN,
    });
    expect(restored.draftRestoredFromVersion).toBe(1);
    const third = await publishHarnessProfile(db, {
      profileId: created.id,
      expectedRevision: restored.draftRevision,
      actor: ADMIN,
    });
    expect(third.version).toMatchObject({
      version: 3,
      restoredFromVersion: 1,
    });

    const fork = await forkHarnessProfile(db, {
      profileId: created.id,
      slug: "lifecycle-fork",
      expectedRevision: restored.draftRevision,
      actor: ADMIN,
    });
    expect(fork.id).not.toBe(created.id);
    expect(fork.publishedVersion).toBeNull();

    const archived = await archiveHarnessProfile(db, {
      profileId: created.id,
      expectedRevision: restored.draftRevision,
      actor: ADMIN,
    });
    expect(archived.archivedAt).not.toBeNull();
    expect(
      (await listHarnessProfiles(db, { organizationId: "org-a" })).some(
        (profile) => profile.id === created.id,
      ),
    ).toBe(false);
    expect(
      await resolveHarnessProfileVersion(db, {
        organizationId: "org-a",
        profileId: created.id,
        version: 1,
      }),
    ).toMatchObject({
      manifest: { profileId: created.id, version: 1 },
      skillArtifacts: [],
    });
  });

  it("does not leave a version when the publish CAS is lost before the atomic claim", async () => {
    const { fixture } = await insertSkillFixture({
      name: "race-skill",
      commitSha: "e".repeat(40),
    });
    const profileDraft = draft();
    profileDraft.skills = [
      { artifactHash: fixture.artifactHash, name: fixture.name },
    ];
    const created = await createHarnessProfile(db, {
      slug: "publish-race",
      draft: profileDraft,
      actor: ADMIN,
    });
    let intercepted = false;
    const racedDb = new Proxy(db, {
      get(target, property) {
        if (property === "execute") {
          return async (...args: Parameters<Db["execute"]>) => {
            if (!intercepted) {
              intercepted = true;
              await db
                .update(harnessProfiles)
                .set({ draftRevision: created.draftRevision + 1 })
                .where(eq(harnessProfiles.id, created.id));
            }
            return target.execute(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;

    await expect(
      publishHarnessProfile(racedDb, {
        profileId: created.id,
        expectedRevision: created.draftRevision,
        actor: ADMIN,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(intercepted).toBe(true);

    const storedVersions = await db
      .select()
      .from(harnessProfileVersions)
      .where(eq(harnessProfileVersions.profileId, created.id));
    expect(storedVersions).toEqual([]);
    expect(
      await db
        .select()
        .from(harnessProfileVersionSkills)
        .where(eq(harnessProfileVersionSkills.profileId, created.id)),
    ).toEqual([]);
    expect(
      await listHarnessProfileVersions(db, {
        organizationId: ADMIN.organizationId,
        profileId: created.id,
      }),
    ).toEqual([]);
    expect(
      await resolveHarnessProfileVersion(db, {
        organizationId: ADMIN.organizationId,
        profileId: created.id,
        version: 1,
      }),
    ).toBeNull();
  });

  it("resolves exact tenant-owned skill bytes while public profile versions retain only hashes", async () => {
    const { fixture } = await insertSkillFixture();

    const skillDraft = draft();
    skillDraft.skills = [
      { artifactHash: fixture.artifactHash, name: fixture.name },
    ];
    const profile = await createHarnessProfile(db, {
      slug: "with-skill",
      draft: skillDraft,
      actor: ADMIN,
    });
    await publishHarnessProfile(db, {
      profileId: profile.id,
      expectedRevision: profile.draftRevision,
      actor: ADMIN,
    });
    const resolved = await resolveHarnessProfileVersion(db, {
      organizationId: "org-a",
      profileId: profile.id,
      version: 1,
    });
    expect(resolved?.skillArtifacts[0]?.files[0]).toMatchObject({
      path: "SKILL.md",
      contentBase64: fixture.files[0]!.contentBase64,
    });
    expect(
      await resolveHarnessProfileVersion(db, {
        organizationId: "org-b",
        profileId: profile.id,
        version: 1,
      }),
    ).toBeNull();
    const versions = await listHarnessProfileVersions(db, {
      organizationId: "org-a",
      profileId: profile.id,
    });
    expect(versions[0]?.manifest.skills).toEqual([
      { artifactHash: fixture.artifactHash, name: fixture.name },
    ]);
    expect(JSON.stringify(versions)).not.toContain(
      fixture.files[0]!.contentBase64,
    );
  });

  it("rejects aliases that could hide duplicate canonical skill names", async () => {
    const first = await insertSkillFixture({
      sourcePath: "review-rules-v1",
      commitSha: "1".repeat(40),
    });
    const second = await insertSkillFixture({
      sourcePath: "review-rules-v2",
      commitSha: "2".repeat(40),
    });
    const profileDraft = draft();
    profileDraft.skills = [
      { artifactHash: first.fixture.artifactHash, name: "review-rules-one" },
      { artifactHash: second.fixture.artifactHash, name: "review-rules-two" },
    ];
    const profile = await createHarnessProfile(db, {
      slug: "aliased-skills",
      draft: profileDraft,
      actor: ADMIN,
    });

    await expect(
      publishHarnessProfile(db, {
        profileId: profile.id,
        expectedRevision: profile.draftRevision,
        actor: ADMIN,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(
        "does not match the pinned artifact name",
      ),
    });
  });

  it("fails closed for tampered bytes, row hashes, and missing files", async () => {
    const tampered = await insertSkillFixture({
      sourcePath: "tampered",
      commitSha: "3".repeat(40),
    });
    const missing = await insertSkillFixture({
      name: "missing-skill",
      sourcePath: "missing",
      commitSha: "4".repeat(40),
    });
    const profileDraft = draft();
    profileDraft.skills = [
      {
        artifactHash: tampered.fixture.artifactHash,
        name: tampered.fixture.name,
      },
      {
        artifactHash: missing.fixture.artifactHash,
        name: missing.fixture.name,
      },
    ];
    const profile = await createHarnessProfile(db, {
      slug: "integrity",
      draft: profileDraft,
      actor: ADMIN,
    });
    await publishHarnessProfile(db, {
      profileId: profile.id,
      expectedRevision: profile.draftRevision,
      actor: ADMIN,
    });

    const changed = Buffer.from(
      "---\nname: review-rules\ndescription: Review rules\n---\n\n# Changed\n",
    );
    await db
      .update(harnessSkillArtifactFiles)
      .set({
        sizeBytes: changed.byteLength,
        sha256: createHash("sha256").update(changed).digest("hex"),
        contentBase64: changed.toString("base64"),
      })
      .where(eq(harnessSkillArtifactFiles.artifactId, tampered.artifact.id));

    await expect(
      publishHarnessProfile(db, {
        profileId: profile.id,
        expectedRevision: profile.draftRevision,
        actor: ADMIN,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      resolveHarnessProfileVersion(db, {
        organizationId: ADMIN.organizationId,
        profileId: profile.id,
        version: 1,
      }),
    ).resolves.toBeNull();

    await db
      .update(harnessSkillArtifactFiles)
      .set({
        ...tampered.fixture.files[0]!,
        sha256: "f".repeat(64),
      })
      .where(eq(harnessSkillArtifactFiles.artifactId, tampered.artifact.id));
    await expect(
      resolveHarnessProfileVersion(db, {
        organizationId: ADMIN.organizationId,
        profileId: profile.id,
        version: 1,
      }),
    ).resolves.toBeNull();

    await db
      .update(harnessSkillArtifactFiles)
      .set(tampered.fixture.files[0]!)
      .where(eq(harnessSkillArtifactFiles.artifactId, tampered.artifact.id));
    await db
      .delete(harnessSkillArtifactFiles)
      .where(eq(harnessSkillArtifactFiles.artifactId, missing.artifact.id));
    await expect(
      resolveHarnessProfileVersion(db, {
        organizationId: ADMIN.organizationId,
        profileId: profile.id,
        version: 1,
      }),
    ).resolves.toBeNull();
  });

  it("keeps system profiles read-only for every organization", async () => {
    await ensureSystemHarnessProfiles(db);
    await expect(
      updateHarnessProfileDraft(db, {
        profileId: "builtin-codex",
        expectedRevision: 1,
        draft: draft(),
        actor: ADMIN,
      }),
    ).rejects.toBeInstanceOf(DashboardAuthError);
  });
});
