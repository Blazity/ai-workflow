import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const openClients: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

async function migrateThrough(lastPrefix: string): Promise<PGlite> {
  const client = new PGlite();
  openClients.push(client);
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql") && file.slice(0, 4) <= lastPrefix)
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  }
  return client;
}

async function applyLocalSkillSource(client: PGlite): Promise<void> {
  await client.exec(
    readFileSync(`${migrationsDir}0046_local_skill_source.sql`, "utf8"),
  );
}

const seedOrganization = `
  INSERT INTO organization (id, name, slug)
  VALUES ('org-skills', 'Skills organization', 'skills-org')
`;

const legacyArtifact = `
  INSERT INTO harness_skill_artifacts (
    organization_id,
    artifact_hash,
    name,
    description,
    source_owner,
    source_repository,
    source_path,
    source_commit_sha,
    created_by_id
  )
  VALUES (
    'org-skills',
    'artifact-hash-legacy',
    'legacy-skill',
    'Imported before local sources existed',
    'blazity',
    'ai-workflow',
    'skills/legacy-skill',
    'a'||repeat('0', 39),
    'admin'
  )
`;

describe("0046 local skill source migration", () => {
  it("leaves an existing artifact untouched and marks it as a GitHub source", async () => {
    const client = await migrateThrough("0043");
    await client.exec(seedOrganization);
    await client.exec(legacyArtifact);

    await applyLocalSkillSource(client);

    const rows = await client.query<{
      source_kind: string;
      source_owner: string | null;
      source_repository: string | null;
      source_path: string | null;
      source_commit_sha: string | null;
      local_path: string | null;
      local_content_sha256: string | null;
    }>(`
      SELECT
        source_kind,
        source_owner,
        source_repository,
        source_path,
        source_commit_sha,
        local_path,
        local_content_sha256
      FROM harness_skill_artifacts
      WHERE artifact_hash = 'artifact-hash-legacy'
    `);
    expect(rows.rows).toEqual([
      {
        source_kind: "github",
        source_owner: "blazity",
        source_repository: "ai-workflow",
        source_path: "skills/legacy-skill",
        source_commit_sha: `a${"0".repeat(39)}`,
        local_path: null,
        local_content_sha256: null,
      },
    ]);
  });

  it("keeps the GitHub import path working without naming the new column", async () => {
    const client = await migrateThrough("0043");
    await client.exec(seedOrganization);

    await applyLocalSkillSource(client);
    // The one production writer inserts through raw SQL that predates
    // source_kind; the backfill default has to carry it.
    await client.exec(legacyArtifact);

    const rows = await client.query<{ source_kind: string }>(`
      SELECT source_kind
      FROM harness_skill_artifacts
      WHERE artifact_hash = 'artifact-hash-legacy'
    `);
    expect(rows.rows).toEqual([{ source_kind: "github" }]);
  });

  it("accepts a local artifact that carries only the local columns", async () => {
    const client = await migrateThrough("0046");
    await client.exec(seedOrganization);

    await client.exec(`
      INSERT INTO harness_skill_artifacts (
        organization_id,
        artifact_hash,
        name,
        source_kind,
        local_path,
        local_content_sha256,
        created_by_id
      )
      VALUES (
        'org-skills',
        'artifact-hash-local',
        'local-skill',
        'local',
        'skills/local-skill',
        repeat('b', 64),
        'admin'
      )
    `);

    const rows = await client.query<{
      source_kind: string;
      source_owner: string | null;
      local_path: string | null;
    }>(`
      SELECT source_kind, source_owner, local_path
      FROM harness_skill_artifacts
      WHERE artifact_hash = 'artifact-hash-local'
    `);
    expect(rows.rows).toEqual([
      {
        source_kind: "local",
        source_owner: null,
        local_path: "skills/local-skill",
      },
    ]);
  });

  it("rejects an unknown source kind", async () => {
    const client = await migrateThrough("0046");
    await client.exec(seedOrganization);

    await expect(
      client.exec(`
        INSERT INTO harness_skill_artifacts (
          organization_id, artifact_hash, name, source_kind, created_by_id
        )
        VALUES ('org-skills', 'artifact-hash-gitlab', 'x', 'gitlab', 'admin')
      `),
    ).rejects.toThrow(/harness_skill_artifacts_source_kind_check/);
  });

  it.each([
    [
      "a GitHub row missing a GitHub column",
      `
        (organization_id, artifact_hash, name, source_kind,
         source_owner, source_repository, source_path, created_by_id)
        VALUES ('org-skills', 'artifact-hash-mixed-1', 'x', 'github',
                'blazity', 'ai-workflow', 'skills/x', 'admin')
      `,
    ],
    [
      "a GitHub row that also carries local columns",
      `
        (organization_id, artifact_hash, name, source_kind,
         source_owner, source_repository, source_path, source_commit_sha,
         local_path, local_content_sha256, created_by_id)
        VALUES ('org-skills', 'artifact-hash-mixed-2', 'x', 'github',
                'blazity', 'ai-workflow', 'skills/x', 'deadbeef',
                'skills/x', repeat('c', 64), 'admin')
      `,
    ],
    [
      "a local row missing its content digest",
      `
        (organization_id, artifact_hash, name, source_kind,
         local_path, created_by_id)
        VALUES ('org-skills', 'artifact-hash-mixed-3', 'x', 'local',
                'skills/x', 'admin')
      `,
    ],
    [
      "a local row that also carries GitHub columns",
      `
        (organization_id, artifact_hash, name, source_kind,
         local_path, local_content_sha256, source_owner, created_by_id)
        VALUES ('org-skills', 'artifact-hash-mixed-4', 'x', 'local',
                'skills/x', repeat('d', 64), 'blazity', 'admin')
      `,
    ],
  ])("rejects %s", async (_label, values) => {
    const client = await migrateThrough("0046");
    await client.exec(seedOrganization);

    await expect(
      client.exec(`INSERT INTO harness_skill_artifacts ${values}`),
    ).rejects.toThrow(/harness_skill_artifacts_source_shape_check/);
  });
});
