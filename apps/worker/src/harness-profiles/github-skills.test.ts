import { beforeEach, describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import type { Db } from "../db/client.js";
import {
  harnessSkillArtifactFiles,
  harnessSkillArtifacts,
  organization,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  discoverGitHubSkills,
  extractRepositoryFiles,
  HarnessSkillImportError,
  importGitHubSkills,
  parseGitHubSkillLocator,
  refreshGitHubSkillArtifact,
  type GitHubSkillRepository,
  type GitHubSkillTreeEntry,
} from "./github-skills.js";

const COMMIT_ONE = "1".repeat(40);
const COMMIT_TWO = "2".repeat(40);
const TREE_ONE = "3".repeat(40);
const TREE_TWO = "4".repeat(40);

function validSkill(name = "review-rules", description = "Review rules"): Buffer {
  return Buffer.from(
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

class FakeRepository implements GitHubSkillRepository {
  defaultBranch = "main";
  commits = new Map<string, { commitSha: string; treeSha: string }>([
    ["main", { commitSha: COMMIT_ONE, treeSha: TREE_ONE }],
    [COMMIT_ONE, { commitSha: COMMIT_ONE, treeSha: TREE_ONE }],
    [COMMIT_TWO, { commitSha: COMMIT_TWO, treeSha: TREE_TWO }],
  ]);
  trees = new Map<
    string,
    { entries: GitHubSkillTreeEntry[]; truncated: boolean }
  >();
  blobs = new Map<string, Buffer>();
  calls: string[] = [];

  async getDefaultBranch(): Promise<string> {
    this.calls.push("default");
    return this.defaultBranch;
  }

  async resolveCommit(input: {
    ref: string;
  }): Promise<{ commitSha: string; treeSha: string }> {
    this.calls.push(`commit:${input.ref}`);
    const resolved = this.commits.get(input.ref);
    if (!resolved) throw new Error("missing commit");
    return resolved;
  }

  async getTree(input: {
    treeSha: string;
  }): Promise<{ entries: GitHubSkillTreeEntry[]; truncated: boolean }> {
    this.calls.push(`tree:${input.treeSha}`);
    const tree = this.trees.get(input.treeSha);
    if (!tree) throw new Error("missing tree");
    return tree;
  }

  async getFiles(input: {
    commitSha: string;
    paths: string[];
  }): Promise<Map<string, Buffer>> {
    this.calls.push(`files:${input.commitSha}:${input.paths.length}`);
    const resolved = this.commits.get(input.commitSha);
    if (!resolved) throw new Error("missing commit");
    const tree = this.trees.get(resolved.treeSha);
    if (!tree) throw new Error("missing tree");
    const files = new Map<string, Buffer>();
    for (const path of input.paths) {
      const entry = tree.entries.find((candidate) => candidate.path === path);
      const blob = entry ? this.blobs.get(entry.sha) : undefined;
      if (blob) files.set(path, Buffer.from(blob));
    }
    return files;
  }
}

function addSkill(
  repository: FakeRepository,
  input?: {
    treeSha?: string;
    path?: string;
    name?: string;
    scriptMode?: "100644" | "100755";
  },
): void {
  const treeSha = input?.treeSha ?? TREE_ONE;
  const path = input?.path ?? "skills/review-rules";
  const skillSha = "a".repeat(40);
  const scriptSha = "b".repeat(40);
  const skill = validSkill(input?.name);
  const script = Buffer.from("#!/bin/sh\necho review\n");
  repository.blobs.set(skillSha, skill);
  repository.blobs.set(scriptSha, script);
  repository.trees.set(treeSha, {
    truncated: false,
    entries: [
      {
        path: `${path}/SKILL.md`,
        mode: "100644",
        type: "blob",
        sha: skillSha,
        size: skill.length,
      },
      {
        path: `${path}/scripts/check.sh`,
        mode: input?.scriptMode ?? "100755",
        type: "blob",
        sha: scriptSha,
        size: script.length,
      },
    ],
  });
}

function addManySkills(repository: FakeRepository, count: number): string[] {
  const paths: string[] = [];
  const entries: GitHubSkillTreeEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const path = `skills/skill-${index}`;
    const sha = index.toString(16).padStart(40, "0");
    const skill = validSkill(`skill-${index}`, `Skill ${index}`);
    paths.push(path);
    repository.blobs.set(sha, skill);
    entries.push({
      path: `${path}/SKILL.md`,
      mode: "100644",
      type: "blob",
      sha,
      size: skill.length,
    });
  }
  repository.trees.set(TREE_ONE, { truncated: false, entries });
  return paths;
}

let db: Db;

describe("GitHub skill source parsing", () => {
  it.each([
    [
      "acme/skills",
      { owner: "acme", repository: "skills", ref: null, path: "" },
    ],
    [
      "acme/skills/review/rules",
      {
        owner: "acme",
        repository: "skills",
        ref: null,
        path: "review/rules",
      },
    ],
    [
      "https://github.com/acme/skills.git",
      { owner: "acme", repository: "skills", ref: null, path: "" },
    ],
    [
      "https://github.com/acme/skills/tree/main/review/rules",
      {
        owner: "acme",
        repository: "skills",
        ref: "main",
        path: "review/rules",
      },
    ],
  ])("parses %s", (source, expected) => {
    expect(parseGitHubSkillLocator(source)).toEqual(expected);
  });

  it.each([
    "https://gitlab.com/acme/skills",
    "https://github.com/acme/skills?ref=main",
    "/acme/skills",
    "acme",
    "acme/../skills",
    "acme/skills/../../outside",
    "git@github.com:acme/skills.git",
  ])("rejects unsafe or unsupported source %s", (source) => {
    expect(() => parseGitHubSkillLocator(source)).toThrow(
      HarnessSkillImportError,
    );
  });
});

describe("GitHub skill discovery", () => {
  it("resolves the default branch once and returns only valid skills at an exact SHA", async () => {
    const repository = new FakeRepository();
    addSkill(repository);
    const invalidSha = "c".repeat(40);
    repository.blobs.set(invalidSha, Buffer.from("# Missing front matter"));
    repository.trees.get(TREE_ONE)!.entries.push({
      path: "skills/invalid/SKILL.md",
      mode: "100644",
      type: "blob",
      sha: invalidSha,
      size: 22,
    });

    const discovered = await discoverGitHubSkills({
      repository,
      source: "acme/skills/skills",
    });
    expect(discovered).toEqual({
      source: {
        owner: "acme",
        repository: "skills",
        commitSha: COMMIT_ONE,
      },
      skills: [
        {
          name: "review-rules",
          path: "skills/review-rules",
          description: "Review rules",
        },
      ],
    });
    expect(repository.calls.slice(0, 3)).toEqual([
      "default",
      "commit:main",
      `tree:${TREE_ONE}`,
    ]);
  });

  it("fails before snapshot download when discovery exceeds the candidate cap", async () => {
    const repository = new FakeRepository();
    repository.trees.set(TREE_ONE, {
      truncated: false,
      entries: Array.from({ length: 501 }, (_, index) => ({
        path: `skills/skill-${index}/SKILL.md`,
        mode: "100644",
        type: "blob" as const,
        sha: index.toString(16).padStart(40, "0"),
        size: 20,
      })),
    });
    await expect(
      discoverGitHubSkills({ repository, source: "acme/skills" }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(repository.calls.some((call) => call.startsWith("files:"))).toBe(
      false,
    );
  });

  it("loads many skill documents from one exact-commit snapshot", async () => {
    const repository = new FakeRepository();
    const entries: GitHubSkillTreeEntry[] = [];
    for (let index = 0; index < 41; index += 1) {
      const sha = index.toString(16).padStart(40, "0");
      const content = validSkill(`skill-${index}`, `Skill ${index}`);
      repository.blobs.set(sha, content);
      entries.push({
        path: `skills/engineering/skill-${index}/SKILL.md`,
        mode: "100644",
        type: "blob",
        sha,
        size: content.byteLength,
      });
    }
    repository.trees.set(TREE_ONE, { entries, truncated: false });

    const discovered = await discoverGitHubSkills({
      repository,
      source: "acme/skills",
    });

    expect(discovered.skills).toHaveLength(41);
    expect(
      repository.calls.filter((call) => call.startsWith("files:")),
    ).toEqual([`files:${COMMIT_ONE}:41`]);
  });

  it("prefers conventional skill directories and falls back to recursive discovery", async () => {
    const conventional = new FakeRepository();
    addSkill(conventional, {
      path: "skills/review-rules",
      name: "review-rules",
    });
    const ignoredSha = "d".repeat(40);
    conventional.blobs.set(
      ignoredSha,
      validSkill("fixture-skill", "Fixture skill"),
    );
    conventional.trees.get(TREE_ONE)!.entries.push({
      path: "examples/fixture-skill/SKILL.md",
      mode: "100644",
      type: "blob",
      sha: ignoredSha,
      size: 80,
    });
    await expect(
      discoverGitHubSkills({
        repository: conventional,
        source: "acme/skills",
      }),
    ).resolves.toMatchObject({
      skills: [{ name: "review-rules" }],
    });

    const fallback = new FakeRepository();
    addSkill(fallback, {
      path: "catalog/custom-skill",
      name: "custom-skill",
    });
    await expect(
      discoverGitHubSkills({
        repository: fallback,
        source: "acme/skills",
      }),
    ).resolves.toMatchObject({
      skills: [{ name: "custom-skill" }],
    });
  });

  it("rejects truncated or inaccessible repository data without exposing provider errors", async () => {
    const truncated = new FakeRepository();
    truncated.trees.set(TREE_ONE, { entries: [], truncated: true });
    await expect(
      discoverGitHubSkills({ repository: truncated, source: "acme/skills" }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: expect.not.stringContaining("missing tree"),
    });

    const inaccessible = new FakeRepository();
    await expect(
      discoverGitHubSkills({
        repository: inaccessible,
        source: "acme/skills",
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message:
        "GitHub repository could not be read with the organization installation",
    });
  });
});

describe("GitHub repository snapshots", () => {
  it("extracts requested files from one tarball and ignores unrelated files", async () => {
    const archive = pack();
    archive.entry(
      { name: "acme-skills-commit/skills/review/SKILL.md" },
      validSkill(),
    );
    archive.entry(
      { name: "acme-skills-commit/large-unrelated.bin" },
      Buffer.alloc(2 * 1024 * 1024),
    );
    archive.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of archive) chunks.push(Buffer.from(chunk));

    const files = await extractRepositoryFiles(
      gzipSync(Buffer.concat(chunks)),
      new Set(["skills/review/SKILL.md"]),
    );

    expect([...files.keys()]).toEqual(["skills/review/SKILL.md"]);
  });

  it("rejects snapshots with multiple root directories", async () => {
    const archive = pack();
    archive.entry(
      { name: "first-root/skills/review/SKILL.md" },
      validSkill(),
    );
    archive.entry(
      { name: "second-root/skills/other/SKILL.md" },
      validSkill("other", "Other"),
    );
    archive.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of archive) chunks.push(Buffer.from(chunk));

    await expect(
      extractRepositoryFiles(
        gzipSync(Buffer.concat(chunks)),
        new Set([
          "skills/review/SKILL.md",
          "skills/other/SKILL.md",
        ]),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("GitHub skill import", () => {
  beforeEach(async () => {
    db = await createTestDb();
    await db
      .insert(organization)
      .values({ id: "org-skills", name: "Skills", slug: "skills-test" });
  });

  it("imports and reuses an exact-SHA artifact with hashes, modes, and no public bytes", async () => {
    const repository = new FakeRepository();
    addSkill(repository);
    const request = {
      source: {
        owner: "acme",
        repository: "skills",
        commitSha: COMMIT_ONE,
      },
      paths: ["skills/review-rules"],
    };
    const [artifact] = await importGitHubSkills(db, {
      repository,
      organizationId: "org-skills",
      actorId: "admin",
      request,
    });
    expect(artifact).toMatchObject({
      artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      organizationId: "org-skills",
      name: "review-rules",
      source: { ...request.source, path: "skills/review-rules" },
      files: [
        { path: "scripts/check.sh", mode: 0o755 },
        { path: "SKILL.md", mode: 0o644 },
      ],
    });
    expect(JSON.stringify(artifact)).not.toContain("contentBase64");

    const [again] = await importGitHubSkills(db, {
      repository,
      organizationId: "org-skills",
      actorId: "admin",
      request,
    });
    expect(again?.artifactHash).toBe(artifact?.artifactHash);
    expect(await db.select().from(harnessSkillArtifacts)).toHaveLength(1);
    const storedFiles = await db.select().from(harnessSkillArtifactFiles);
    expect(storedFiles).toHaveLength(2);
    expect(storedFiles.every((file) => file.contentBase64.length > 0)).toBe(
      true,
    );
  });

  it("imports a 41-skill repository snapshot in one bounded bulk operation", async () => {
    const repository = new FakeRepository();
    const paths = addManySkills(repository, 41);
    const startedAt = performance.now();

    const artifacts = await importGitHubSkills(db, {
      repository,
      organizationId: "org-skills",
      actorId: "admin",
      request: {
        source: {
          owner: "acme",
          repository: "skills",
          commitSha: COMMIT_ONE,
        },
        paths,
      },
    });

    expect(performance.now() - startedAt).toBeLessThan(10_000);
    expect(artifacts).toHaveLength(41);
    expect(repository.calls).toContain(`files:${COMMIT_ONE}:41`);
    expect(await db.select().from(harnessSkillArtifacts)).toHaveLength(41);
    expect(await db.select().from(harnessSkillArtifactFiles)).toHaveLength(41);
  });

  it("prevents branch movement and rejects traversal, malformed skills, symlinks, and submodules", async () => {
    const moved = new FakeRepository();
    addSkill(moved);
    moved.commits.set(COMMIT_ONE, {
      commitSha: COMMIT_TWO,
      treeSha: TREE_TWO,
    });
    await expect(
      importGitHubSkills(db, {
        repository: moved,
        organizationId: "org-skills",
        actorId: "admin",
        request: {
          source: {
            owner: "acme",
            repository: "skills",
            commitSha: COMMIT_ONE,
          },
          paths: ["skills/review-rules"],
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const repository = new FakeRepository();
    addSkill(repository);
    await expect(
      importGitHubSkills(db, {
        repository,
        organizationId: "org-skills",
        actorId: "admin",
        request: {
          source: {
            owner: "acme",
            repository: "skills",
            commitSha: COMMIT_ONE,
          },
          paths: ["../outside"],
        },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    for (const entry of [
      {
        path: "skills/review-rules/link",
        mode: "120000",
        type: "blob" as const,
      },
      {
        path: "skills/review-rules/vendor",
        mode: "160000",
        type: "commit" as const,
      },
    ]) {
      const unsafe = new FakeRepository();
      addSkill(unsafe);
      unsafe.trees.get(TREE_ONE)!.entries.push({
        ...entry,
        sha: "d".repeat(40),
      });
      await expect(
        importGitHubSkills(db, {
          repository: unsafe,
          organizationId: "org-skills",
          actorId: "admin",
          request: {
            source: {
              owner: "acme",
              repository: "skills",
              commitSha: COMMIT_ONE,
            },
            paths: ["skills/review-rules"],
          },
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }

    const malformed = new FakeRepository();
    addSkill(malformed);
    const malformedContent = Buffer.from("---\nname: BAD NAME\n---");
    malformed.blobs.set("a".repeat(40), malformedContent);
    malformed.trees.get(TREE_ONE)!.entries[0]!.size =
      malformedContent.byteLength;
    await expect(
      importGitHubSkills(db, {
        repository: malformed,
        organizationId: "org-skills",
        actorId: "admin",
        request: {
          source: {
            owner: "acme",
            repository: "skills",
            commitSha: COMMIT_ONE,
          },
          paths: ["skills/review-rules"],
        },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects per-file and aggregate limits before persistence", async () => {
    const repository = new FakeRepository();
    addSkill(repository);
    repository.trees.get(TREE_ONE)!.entries[1]!.size = 1024 * 1024 + 1;
    await expect(
      importGitHubSkills(db, {
        repository,
        organizationId: "org-skills",
        actorId: "admin",
        request: {
          source: {
            owner: "acme",
            repository: "skills",
            commitSha: COMMIT_ONE,
          },
          paths: ["skills/review-rules"],
        },
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(await db.select().from(harnessSkillArtifacts)).toHaveLength(0);
  });

  it("refreshes from the repository default branch into a new immutable artifact", async () => {
    const repository = new FakeRepository();
    addSkill(repository);
    const [original] = await importGitHubSkills(db, {
      repository,
      organizationId: "org-skills",
      actorId: "admin",
      request: {
        source: {
          owner: "acme",
          repository: "skills",
          commitSha: COMMIT_ONE,
        },
        paths: ["skills/review-rules"],
      },
    });
    repository.commits.set("main", {
      commitSha: COMMIT_TWO,
      treeSha: TREE_TWO,
    });
    addSkill(repository, {
      treeSha: TREE_TWO,
      name: "review-rules",
    });
    const updatedSha = "e".repeat(40);
    const updatedSkill = validSkill("review-rules", "Updated review rules");
    repository.blobs.set(updatedSha, updatedSkill);
    const updatedEntry = repository.trees
      .get(TREE_TWO)!
      .entries.find((entry) => entry.path.endsWith("/SKILL.md"))!;
    updatedEntry.sha = updatedSha;
    updatedEntry.size = updatedSkill.byteLength;

    const refreshed = await refreshGitHubSkillArtifact(db, {
      repository,
      organizationId: "org-skills",
      actorId: "admin",
      artifactHash: original!.artifactHash,
    });
    expect(refreshed.artifactHash).not.toBe(original!.artifactHash);
    expect(refreshed.source).toMatchObject({ commitSha: COMMIT_TWO });
    expect(await db.select().from(harnessSkillArtifacts)).toHaveLength(2);
  });

  it("refuses a deployment-local artifact before touching the provider", async () => {
    const artifactHash = "f".repeat(64);
    await db.insert(harnessSkillArtifacts).values({
      organizationId: "org-skills",
      artifactHash,
      name: "local-skill",
      sourceKind: "local",
      localPath: "skills/local-skill",
      localContentSha256: "a".repeat(64),
      createdById: "admin",
    });
    const repository = new FakeRepository();

    const error = await refreshGitHubSkillArtifact(db, {
      repository,
      organizationId: "org-skills",
      actorId: "admin",
      artifactHash,
    }).then(
      () => null,
      (reason: unknown) => reason,
    );

    // Callers route deployment skills to the local refresher; reaching this
    // function with one is a wiring mistake, and it must stay a mapped client
    // error rather than an unmapped 500 from the provider call that follows.
    expect(error).toBeInstanceOf(HarnessSkillImportError);
    expect(error).toMatchObject({
      statusCode: 400,
      message: "Only a GitHub-sourced skill artifact can be refreshed from GitHub",
    });
    expect(repository.calls).toEqual([]);
  });
});
