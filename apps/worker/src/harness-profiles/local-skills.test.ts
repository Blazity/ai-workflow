import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import {
  harnessSkillArtifactFiles,
  harnessSkillArtifacts,
  organization,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { HarnessSkillImportError } from "./github-skills.js";
import {
  checkLocalSkills,
  defaultLocalSkillsDirectory,
  discoverLocalSkills,
  importLocalSkills,
  readLocalSkills,
  refreshLocalSkillArtifact,
} from "./local-skills.js";
import { hashHarnessSkillArtifact } from "./skill-artifact.js";

const roots: string[] = [];

function skillsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "local-skills-"));
  roots.push(root);
  return root;
}

function skillDocument(
  name = "review-rules",
  description = "Client-specific review rules.",
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

function writeSkill(
  root: string,
  path: string,
  files: Record<string, string> = { "SKILL.md": skillDocument() },
): string {
  const directory = join(root, path);
  for (const [relativePath, content] of Object.entries(files)) {
    const file = join(directory, relativePath);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }
  return directory;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true });
});

describe("deployment-local skills", () => {
  it("reads a skill directory into an artifact the hasher accepts", async () => {
    const root = skillsRoot();
    const directory = writeSkill(root, "review-rules", {
      "SKILL.md": skillDocument(),
      "scripts/check.sh": "#!/bin/sh\necho review\n",
    });
    chmodSync(join(directory, "scripts/check.sh"), 0o755);

    const { skills, skipped, directoryPresent } = await readLocalSkills(root);
    const [skill, ...rest] = skills;

    expect(directoryPresent).toBe(true);
    expect(skipped).toEqual([]);
    expect(rest).toEqual([]);
    expect(skill).toMatchObject({
      name: "review-rules",
      description: "Client-specific review rules.",
      source: {
        path: "review-rules",
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      files: [
        { path: "scripts/check.sh", mode: 0o755 },
        { path: "SKILL.md", mode: 0o644 },
      ],
    });
    expect(
      Buffer.from(skill!.files[1]!.contentBase64, "base64").toString("utf8"),
    ).toBe(skillDocument());
    expect(hashHarnessSkillArtifact(skill!)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("separates a missing directory from a directory holding nothing usable", async () => {
    await expect(
      readLocalSkills(join(tmpdir(), "local-skills-absent")),
    ).resolves.toEqual({
      directoryPresent: false,
      skills: [],
      skipped: [],
    });

    const empty = skillsRoot();
    await expect(readLocalSkills(empty)).resolves.toEqual({
      directoryPresent: true,
      skills: [],
      skipped: [],
    });
  });

  it("finds the directory in both the deployed bundle and the development tree", async () => {
    // The bundle: the copy sits beside the code the function runs, so the
    // working directory holds it.
    const bundle = skillsRoot();
    mkdirSync(join(bundle, "skills"));
    expect(defaultLocalSkillsDirectory(bundle)).toBe(join(bundle, "skills"));

    // The development tree: the working directory is apps/worker, while the
    // directory belongs to the repository two levels up.
    const repository = skillsRoot();
    mkdirSync(join(repository, "skills"));
    const worker = join(repository, "apps", "worker");
    mkdirSync(worker, { recursive: true });
    expect(defaultLocalSkillsDirectory(worker)).toBe(join(repository, "skills"));

    // Neither: the deployment ships none, and the path it would have shipped
    // them in is the one reported.
    const bare = skillsRoot();
    expect(defaultLocalSkillsDirectory(bare)).toBe(join(bare, "skills"));
  });

  it("fails the build for an entry that cannot ship and passes without a directory", async () => {
    const broken = skillsRoot();
    writeSkill(broken, "review-rules");
    writeSkill(broken, "notes", { "README.md": "Not a skill.\n" });

    const rejected = await checkLocalSkills(broken);
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain("skills/notes");
    expect(rejected.message).toContain("No SKILL.md");

    const healthy = skillsRoot();
    writeSkill(healthy, "review-rules");
    await expect(checkLocalSkills(healthy)).resolves.toEqual({
      ok: true,
      message: `Validated 1 deployment skill(s) at ${healthy}.`,
    });

    const absent = join(tmpdir(), "local-skills-absent-gate");
    await expect(checkLocalSkills(absent)).resolves.toEqual({
      ok: true,
      message: `No deployment skills directory at ${absent}; none will ship.`,
    });
  });

  it("reports why a directory is not a skill, including one nested a level too deep", async () => {
    const root = skillsRoot();
    writeSkill(root, "notes", { "README.md": "Not a skill.\n" });
    writeSkill(root, "nested/review-notes", {
      "SKILL.md": skillDocument("review-notes", "Nested by mistake."),
    });
    writeSkill(root, "review-rules");
    writeFileSync(join(root, "README.md"), "Skills live here.\n");

    const read = await readLocalSkills(root);

    expect(read.skills).toMatchObject([{ name: "review-rules" }]);
    expect(read.skipped).toEqual([
      {
        path: "nested",
        reason:
          'No SKILL.md here, but "review-notes/SKILL.md" exists: a skill must sit one level under the skills directory',
      },
      { path: "notes", reason: "No SKILL.md" },
    ]);
  });

  it.each([
    [
      "an invalid skill name",
      (root: string) =>
        writeSkill(root, "broken", {
          "SKILL.md": skillDocument("BAD NAME"),
        }),
      /invalid name/,
    ],
    [
      "a description past the length limit",
      (root: string) =>
        writeSkill(root, "broken", {
          "SKILL.md": skillDocument("broken", "d".repeat(1_025)),
        }),
      /invalid description/,
    ],
    [
      "a file over the per-file limit",
      (root: string) =>
        writeSkill(root, "broken", {
          "SKILL.md": skillDocument("broken"),
          "reference.md": "d".repeat(1024 * 1024 + 1),
        }),
      /is too large/,
    ],
    [
      "an artifact over the total size limit",
      (root: string) =>
        writeSkill(root, "broken", {
          "SKILL.md": skillDocument("broken"),
          ...Object.fromEntries(
            Array.from({ length: 6 }, (_, index) => [
              `reference-${index}.md`,
              "d".repeat(1024 * 1024),
            ]),
          ),
        }),
      /5 MiB size limit/,
    ],
    [
      "more files than the limit allows",
      (root: string) =>
        writeSkill(root, "broken", {
          "SKILL.md": skillDocument("broken"),
          ...Object.fromEntries(
            Array.from({ length: 500 }, (_, index) => [
              `reference-${index}.md`,
              "reference\n",
            ]),
          ),
        }),
      /500 files/,
    ],
    [
      // A POSIX file name may contain a backslash, which is a traversal
      // separator once the path leaves this process. Artifact verification
      // rejects such a path too; catching it here keeps the read honest.
      "a file name that traverses out of the skill",
      (root: string) =>
        writeSkill(root, "broken", {
          "SKILL.md": skillDocument("broken"),
          "..\\..\\escape.md": "escaped\n",
        }),
      /unsafe file path/,
    ],
    [
      "a symlink pointing outside the skill",
      (root: string) => {
        const directory = writeSkill(root, "broken", {
          "SKILL.md": skillDocument("broken"),
        });
        symlinkSync("/etc/passwd", join(directory, "escape.md"));
        return directory;
      },
      /symlink/,
    ],
    [
      "a SKILL.md that is a symlink rather than a file",
      (root: string) => {
        const directory = join(root, "broken");
        mkdirSync(directory, { recursive: true });
        symlinkSync("/etc/passwd", join(directory, "SKILL.md"));
        return directory;
      },
      /not a regular file/,
    ],
    [
      "an executable SKILL.md",
      (root: string) => {
        const directory = writeSkill(root, "broken", {
          "SKILL.md": skillDocument("broken"),
        });
        chmodSync(join(directory, "SKILL.md"), 0o755);
        return directory;
      },
      /must not be executable/,
    ],
  ])(
    "skips %s without costing the healthy skills beside it",
    async (_label, prepare, reason) => {
      const root = skillsRoot();
      prepare(root);
      writeSkill(root, "review-rules");

      const read = await readLocalSkills(root);

      expect(read.skills).toMatchObject([{ name: "review-rules" }]);
      expect(read.skipped).toMatchObject([
        { path: "broken", reason: expect.stringMatching(reason) },
      ]);
    },
  );

  it("names both directories when two skills claim one name", async () => {
    const root = skillsRoot();
    writeSkill(root, "a-copy", { "SKILL.md": skillDocument("review-rules") });
    writeSkill(root, "b-original", {
      "SKILL.md": skillDocument("review-rules"),
    });

    const read = await readLocalSkills(root);

    expect(read.skills).toMatchObject([{ source: { path: "a-copy" } }]);
    expect(read.skipped).toEqual([
      {
        path: "b-original",
        reason: 'Skill name "review-rules" is already used by "a-copy"',
      },
    ]);
  });

  it("reports the errno when the skills path cannot be read at all", async () => {
    const root = skillsRoot();
    const file = join(root, "skills");
    writeFileSync(file, "not a directory\n");

    const error = await readLocalSkills(file).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(HarnessSkillImportError);
    expect(error).toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("ENOTDIR"),
    });
  });

  it("bounds the whole directory, not just one skill at a time", async () => {
    // Every per-skill limit passes here: each skill sits at 4 MiB, under the
    // 5 MiB ceiling, and carries five files, far under 500. Only a budget
    // spanning the read catches this, and without one the reader would hold
    // 28 MiB of bytes plus their base64 in a serverless function.
    const root = skillsRoot();
    for (let skill = 0; skill < 8; skill += 1) {
      writeSkill(root, `skill-${skill}`, {
        "SKILL.md": skillDocument(`skill-${skill}`),
        ...Object.fromEntries(
          Array.from({ length: 4 }, (_, index) => [
            `reference-${index}.md`,
            "e".repeat(1024 * 1024),
          ]),
        ),
      });
    }

    const read = await readLocalSkills(root);

    // The budget is spent in directory order, so the skill it lands on is an
    // accident of ordering: naming it is the only way the operator can tell
    // which read was cut short from which skill is oversized.
    expect(read.skills.map((skill) => skill.name)).toEqual([
      "skill-0",
      "skill-1",
      "skill-2",
      "skill-3",
      "skill-4",
      "skill-5",
    ]);
    expect(read.skipped).toEqual([
      {
        path: "skill-6",
        reason:
          'Not read: skill "skill-6" exhausted the 25 MiB deployment skills budget',
      },
      {
        path: "skill-7",
        reason:
          'Not read: the deployment skills budget was exhausted at "skill-6"',
      },
    ]);
  });

  it("derives the same content digest from the same bytes and a different one from any edit", async () => {
    const files = {
      "SKILL.md": skillDocument(),
      "reference.md": "Reference notes.\n",
    };
    const first = skillsRoot();
    writeSkill(first, "review-rules", files);
    const second = skillsRoot();
    writeSkill(second, "review-rules", files);
    const edited = skillsRoot();
    writeSkill(edited, "review-rules", {
      ...files,
      "reference.md": "Reference notes,\n",
    });
    const renamed = skillsRoot();
    writeSkill(renamed, "review-rules", {
      "SKILL.md": files["SKILL.md"],
      "notes.md": files["reference.md"],
    });

    const digest = async (root: string) =>
      (await readLocalSkills(root)).skills[0]!.source.contentSha256;

    expect(await digest(second)).toBe(await digest(first));
    expect(await digest(edited)).not.toBe(await digest(first));
    expect(await digest(renamed)).not.toBe(await digest(first));
  });
});

describe("deployment-local skill discovery and import", () => {
  let db: Db;

  /** The selection the dashboard would send: path plus the advertised hash. */
  async function selection(
    root: string,
    path: string,
  ): Promise<{ path: string; artifactHash: string }> {
    const discovery = await discoverLocalSkills(root);
    return {
      path,
      artifactHash: discovery.skills.find((skill) => skill.path === path)!
        .artifactHash,
    };
  }

  beforeEach(async () => {
    db = await createTestDb();
    await db
      .insert(organization)
      .values({ id: "org-skills", name: "Skills", slug: "skills-test" });
  });

  it("discovers what the deployment ships without any repository coordinate", async () => {
    const root = skillsRoot();
    writeSkill(root, "review-rules");
    writeSkill(root, "release-notes", {
      "SKILL.md": skillDocument("release-notes", "How releases are written."),
    });

    // The signature is the argument: there is no repository, no provider and
    // no credential to pass, so a tenant without a GitHub App reaches this.
    const discovery = await discoverLocalSkills(root);

    expect(discovery).toEqual({
      directoryPresent: true,
      skipped: [],
      skills: [
        {
          name: "release-notes",
          path: "release-notes",
          description: "How releases are written.",
          artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          name: "review-rules",
          path: "review-rules",
          description: "Client-specific review rules.",
          artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });

    // The advertised hash is the identity an import mints, which is what makes
    // a pin comparable against what the deployment currently carries.
    const [imported] = await importLocalSkills(db, {
      organizationId: "org-skills",
      actorId: "admin",
      skills: [
        {
          path: "review-rules",
          artifactHash: discovery.skills[1]!.artifactHash,
        },
      ],
      directory: root,
    });
    expect(imported?.artifactHash).toBe(discovery.skills[1]!.artifactHash);
  });

  it("stores a selected skill as a local row the 0046 shape check accepts", async () => {
    const root = skillsRoot();
    writeSkill(root, "review-rules", {
      "SKILL.md": skillDocument(),
      "reference.md": "Reference notes.\n",
    });

    const [artifact] = await importLocalSkills(db, {
      organizationId: "org-skills",
      actorId: "admin",
      skills: [await selection(root, "review-rules")],
      directory: root,
    });

    expect(artifact).toMatchObject({
      organizationId: "org-skills",
      name: "review-rules",
      source: {
        path: "review-rules",
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      files: [{ path: "reference.md" }, { path: "SKILL.md" }],
    });
    expect(JSON.stringify(artifact)).not.toContain("contentBase64");

    const [row] = await db.select().from(harnessSkillArtifacts);
    expect(row).toMatchObject({
      sourceKind: "local",
      localPath: "review-rules",
      localContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceOwner: null,
      sourceRepository: null,
      sourcePath: null,
      sourceCommitSha: null,
    });
    expect(await db.select().from(harnessSkillArtifactFiles)).toHaveLength(2);
  });

  it("reuses the stored artifact when the same content is imported again", async () => {
    const root = skillsRoot();
    writeSkill(root, "review-rules");
    const request = {
      organizationId: "org-skills",
      actorId: "admin",
      skills: [await selection(root, "review-rules")],
      directory: root,
    };

    const [first] = await importLocalSkills(db, request);
    const [again] = await importLocalSkills(db, request);

    expect(again?.artifactHash).toBe(first?.artifactHash);
    expect(await db.select().from(harnessSkillArtifacts)).toHaveLength(1);
    expect(await db.select().from(harnessSkillArtifactFiles)).toHaveLength(1);
  });

  it("rejects a selection the deployment does not ship", async () => {
    const root = skillsRoot();
    writeSkill(root, "review-rules");

    const error = await importLocalSkills(db, {
      organizationId: "org-skills",
      actorId: "admin",
      skills: [
        await selection(root, "review-rules"),
        { path: "absent", artifactHash: "a".repeat(64) },
      ],
      directory: root,
    }).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(HarnessSkillImportError);
    expect(error).toMatchObject({ statusCode: 400 });
    expect(await db.select().from(harnessSkillArtifacts)).toHaveLength(0);
  });

  it("refuses a selection whose own directory is unusable and names the reason", async () => {
    const root = skillsRoot();
    writeSkill(root, "review-rules");
    writeSkill(root, "broken", { "SKILL.md": skillDocument("BAD NAME") });

    // The healthy selection alone still imports: only a selected entry's own
    // failure is fatal.
    await expect(
      importLocalSkills(db, {
        organizationId: "org-skills",
        actorId: "admin",
        skills: [await selection(root, "review-rules")],
        directory: root,
      }),
    ).resolves.toHaveLength(1);

    const error = await importLocalSkills(db, {
      organizationId: "org-skills",
      actorId: "admin",
      skills: [{ path: "broken", artifactHash: "a".repeat(64) }],
      directory: root,
    }).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("invalid name"),
    });
  });

  it("refuses an import whose hash predates a deployment swap", async () => {
    const root = skillsRoot();
    writeSkill(root, "review-rules");
    const stale = await selection(root, "review-rules");
    // What a promotion between discovery and import looks like to the reader:
    // the same path, different bytes.
    writeSkill(root, "review-rules", {
      "SKILL.md": skillDocument("review-rules", "Rewritten by a redeploy."),
    });

    const error = await importLocalSkills(db, {
      organizationId: "org-skills",
      actorId: "admin",
      skills: [stale],
      directory: root,
    }).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(HarnessSkillImportError);
    expect(error).toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Reload"),
    });
    expect(await db.select().from(harnessSkillArtifacts)).toHaveLength(0);
  });

  it("refreshes a deployment skill into a new artifact after a redeploy changes it", async () => {
    const root = skillsRoot();
    writeSkill(root, "review-rules");
    const [original] = await importLocalSkills(db, {
      organizationId: "org-skills",
      actorId: "admin",
      skills: [await selection(root, "review-rules")],
      directory: root,
    });
    writeSkill(root, "review-rules", {
      "SKILL.md": skillDocument("review-rules", "Rules the client rewrote."),
    });

    const refreshed = await refreshLocalSkillArtifact(db, {
      organizationId: "org-skills",
      actorId: "admin",
      artifactHash: original!.artifactHash,
      directory: root,
    });

    expect(refreshed.artifactHash).not.toBe(original!.artifactHash);
    expect(refreshed.description).toBe("Rules the client rewrote.");
    expect(await db.select().from(harnessSkillArtifacts)).toHaveLength(2);
  });

  it("refuses to refresh a skill the deployment no longer ships", async () => {
    const root = skillsRoot();
    writeSkill(root, "review-rules");
    const [original] = await importLocalSkills(db, {
      organizationId: "org-skills",
      actorId: "admin",
      skills: [await selection(root, "review-rules")],
      directory: root,
    });
    rmSync(join(root, "review-rules"), { force: true, recursive: true });

    const error = await refreshLocalSkillArtifact(db, {
      organizationId: "org-skills",
      actorId: "admin",
      artifactHash: original!.artifactHash,
      directory: root,
    }).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(HarnessSkillImportError);
    expect(error).toMatchObject({
      statusCode: 404,
      message: expect.stringContaining("no longer part of this deployment"),
    });
  });
});
