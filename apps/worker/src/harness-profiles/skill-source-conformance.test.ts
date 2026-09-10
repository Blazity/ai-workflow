import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SkillValidationError } from "@shared/skills";
import {
  githubSkillSource,
  type GitHubSkillRepository,
  type GitHubSkillTreeEntry,
} from "./github-skills.js";
import { localSkillSource } from "./local-skills.js";

const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);
const BLOB = "3".repeat(40);
const roots: string[] = [];

class FixtureRepository implements GitHubSkillRepository {
  constructor(private readonly document: Buffer) {}

  getDefaultBranch(): Promise<string> {
    return Promise.resolve("main");
  }

  resolveCommit(): Promise<{ commitSha: string; treeSha: string }> {
    return Promise.resolve({ commitSha: COMMIT, treeSha: TREE });
  }

  getTree(): Promise<{
    entries: GitHubSkillTreeEntry[];
    truncated: boolean;
  }> {
    return Promise.resolve({
      truncated: false,
      entries: [
        {
          path: "skills/review-rules/SKILL.md",
          mode: "100644",
          type: "blob",
          sha: BLOB,
          size: this.document.byteLength,
        },
      ],
    });
  }

  getFiles(): Promise<Map<string, Buffer>> {
    return Promise.resolve(
      new Map([["skills/review-rules/SKILL.md", Buffer.from(this.document)]]),
    );
  }
}

function fixtureDirectory(document: Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "skill-source-conformance-"));
  roots.push(root);
  const skill = join(root, "review-rules");
  mkdirSync(skill);
  writeFileSync(join(skill, "SKILL.md"), document);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true });
});

it("normalizes the same valid manifest through both source reads", async () => {
  const document = Buffer.from(
    "---\nname: review-rules\ndescription: Review rules\n---\n\n# Rules\n",
  );
  const repository = new FixtureRepository(document);
  const directory = fixtureDirectory(document);
  const [githubDiscovery, localDiscovery] = await Promise.all([
    githubSkillSource.discover({ repository, source: "acme/skills/skills" }),
    localSkillSource.discover({ directory }),
  ]);
  expect(
    githubDiscovery.map(({ name, description }) => ({ name, description })),
  ).toEqual(
    localDiscovery.map(({ name, description }) => ({ name, description })),
  );

  const github = await githubSkillSource.read(githubDiscovery[0]!.snapshot, {
    repository,
  });
  const local = await localSkillSource.read(localDiscovery[0]!.snapshot);

  expect({ name: github.name, description: github.description }).toEqual({
    name: local.name,
    description: local.description,
  });
});

it("surfaces the same package error for malformed manifests", async () => {
  const document = Buffer.from(
    "---\nname: BAD NAME\ndescription: Review rules\n---\n",
  );
  const reads = [
    githubSkillSource.read(
      {
        owner: "acme",
        repository: "skills",
        path: "skills/review-rules",
        commitSha: COMMIT,
      },
      { repository: new FixtureRepository(document) },
    ),
    localSkillSource.read({
      directory: fixtureDirectory(document),
      path: "review-rules",
      artifactHash: "f".repeat(64),
    }),
  ];

  const errors = await Promise.all(
    reads.map((read) => read.then(() => null, (error: unknown) => error)),
  );
  expect(errors).toEqual([
    expect.objectContaining({
      code: "invalid_manifest",
      reason: "SKILL.md has an invalid name.",
    }),
    expect.objectContaining({
      code: "invalid_manifest",
      reason: "SKILL.md has an invalid name.",
    }),
  ]);
  expect(errors.every((error) => error instanceof SkillValidationError)).toBe(
    true,
  );
});

it.each([
    ["github", () => {
      const document = Buffer.from(
        "---\nname: review-rules\ndescription: Review rules\n---\n",
      );
      return githubSkillSource.read(
        {
          owner: "acme",
          repository: "skills",
          path: "skills/review-rules",
          commitSha: COMMIT,
        },
        {
          repository: new FixtureRepository(document),
          expectedArtifactHash: "f".repeat(64),
        },
      );
    }],
    ["local", () => {
      const document = Buffer.from(
        "---\nname: review-rules\ndescription: Review rules\n---\n",
      );
      return localSkillSource.read({
        directory: fixtureDirectory(document),
        path: "review-rules",
        artifactHash: "f".repeat(64),
      });
    }],
])("rejects deterministic %s artifact drift", async (_kind, read) => {
  await expect(read()).rejects.toMatchObject({
    code: "artifact_drift",
    reason: "Resolved skill artifact does not match the expected hash.",
  });
});
