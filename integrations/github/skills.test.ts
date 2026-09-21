import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { pack } from "tar-stream";
import {
  createGitHubSkillSource,
  extractRepositoryFiles,
  SkillSourceError,
} from "./skills";

const octokit = {
  repos: {
    get: vi.fn(),
    getCommit: vi.fn(),
    downloadTarballArchive: vi.fn(),
  },
  git: { getTree: vi.fn() },
};

vi.mock("./auth", () => ({
  buildOctokit: () => octokit,
}));

const CREDENTIAL = { appId: 1, privateKey: "pem", installationId: 2 };
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);

function validSkill(name = "review-rules", description = "Review rules"): Buffer {
  return Buffer.from(
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

async function tarball(
  entries: Array<{ name: string; content: Buffer }>,
): Promise<Buffer> {
  const archive = pack();
  for (const entry of entries) archive.entry({ name: entry.name }, entry.content);
  archive.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(Buffer.from(chunk));
  return gzipSync(Buffer.concat(chunks));
}

describe("GitHub repository snapshots", () => {
  it("extracts requested files from one tarball and ignores unrelated files", async () => {
    const archive = await tarball([
      { name: "acme-skills-commit/skills/review/SKILL.md", content: validSkill() },
      {
        name: "acme-skills-commit/large-unrelated.bin",
        content: Buffer.alloc(2 * 1024 * 1024),
      },
    ]);

    const files = await extractRepositoryFiles(
      archive,
      new Set(["skills/review/SKILL.md"]),
    );

    expect([...files.keys()]).toEqual(["skills/review/SKILL.md"]);
  });

  it("rejects snapshots with multiple root directories", async () => {
    const archive = await tarball([
      { name: "first-root/skills/review/SKILL.md", content: validSkill() },
      {
        name: "second-root/skills/other/SKILL.md",
        content: validSkill("other", "Other"),
      },
    ]);

    await expect(
      extractRepositoryFiles(
        archive,
        new Set(["skills/review/SKILL.md", "skills/other/SKILL.md"]),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("GitHub skill source", () => {
  it("unpacks the snapshot for the exact commit and answers only the wanted paths", async () => {
    const archive = await tarball([
      { name: "acme-skills-abc/skills/review/SKILL.md", content: validSkill() },
      { name: "acme-skills-abc/README.md", content: Buffer.from("# ignored\n") },
    ]);
    octokit.repos.downloadTarballArchive.mockResolvedValue({ data: archive });

    const files = await createGitHubSkillSource(CREDENTIAL).getFiles({
      owner: "acme",
      repository: "skills",
      commitSha: COMMIT,
      paths: ["skills/review/SKILL.md"],
    });

    expect([...files.keys()]).toEqual(["skills/review/SKILL.md"]);
    expect(Buffer.from(files.get("skills/review/SKILL.md")!).toString()).toBe(
      validSkill().toString(),
    );
    // The snapshot has to be pinned to the commit core resolved, not to a ref
    // that can move between discovery and import.
    expect(octokit.repos.downloadTarballArchive).toHaveBeenCalledWith({
      owner: "acme",
      repo: "skills",
      ref: COMMIT,
    });
  });

  it("refuses an archive over the 50 MiB ceiling before unpacking it", async () => {
    octokit.repos.downloadTarballArchive.mockResolvedValue({
      data: Buffer.alloc(50 * 1024 * 1024 + 1),
    });

    const error = await createGitHubSkillSource(CREDENTIAL)
      .getFiles({
        owner: "acme",
        repository: "skills",
        commitSha: COMMIT,
        paths: ["skills/review/SKILL.md"],
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    // Core maps this status straight onto the dashboard response, so a status
    // that stops travelling turns "too large" into a generic read failure.
    expect(error).toBeInstanceOf(SkillSourceError);
    expect(error).toMatchObject({
      status: 413,
      message: "GitHub repository snapshot exceeds the 50 MiB download limit",
    });
  });

  it("refuses a repository with no default branch rather than resolving an empty ref", async () => {
    octokit.repos.get.mockResolvedValue({ data: { default_branch: null } });

    await expect(
      createGitHubSkillSource(CREDENTIAL).getDefaultBranch({
        owner: "acme",
        repository: "skills",
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "GitHub repository has no default branch",
    });
  });

  it("returns tree entries core can validate and refuses an entry it cannot", async () => {
    octokit.git.getTree.mockResolvedValue({
      data: {
        truncated: false,
        tree: [
          {
            path: "skills/review/SKILL.md",
            mode: "100644",
            type: "blob",
            sha: "c".repeat(40),
            size: 42,
          },
        ],
      },
    });

    await expect(
      createGitHubSkillSource(CREDENTIAL).getTree({
        owner: "acme",
        repository: "skills",
        treeSha: TREE,
      }),
    ).resolves.toEqual({
      truncated: false,
      entries: [
        {
          path: "skills/review/SKILL.md",
          mode: "100644",
          type: "blob",
          sha: "c".repeat(40),
          size: 42,
        },
      ],
    });

    octokit.git.getTree.mockResolvedValue({
      data: { truncated: false, tree: [{ path: "skills", type: "blob" }] },
    });
    await expect(
      createGitHubSkillSource(CREDENTIAL).getTree({
        owner: "acme",
        repository: "skills",
        treeSha: TREE,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
