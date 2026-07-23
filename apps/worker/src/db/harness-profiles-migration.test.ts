import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

async function migrateThrough(lastPrefix: string): Promise<PGlite> {
  const client = new PGlite();
  const files = readdirSync(migrationsDir)
    .filter(
      (file) => file.endsWith(".sql") && file.slice(0, 4) <= lastPrefix,
    )
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  }
  return client;
}

describe("0023 Harness Profiles migration", () => {
  it("creates the consolidated profile, version, artifact, and run-manifest schema", async () => {
    const client = await migrateThrough("0023");
    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'harness_%'
      ORDER BY table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "harness_profile_version_skills",
      "harness_profile_versions",
      "harness_profiles",
      "harness_skill_artifact_files",
      "harness_skill_artifacts",
    ]);
    const runColumn = await client.query<{
      data_type: string;
      is_nullable: string;
    }>(`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'workflow_runs'
        AND column_name = 'harness_manifests'
    `);
    expect(runColumn.rows).toEqual([
      { data_type: "jsonb", is_nullable: "YES" },
    ]);

    await client.exec(`
      INSERT INTO organization (id, name, slug)
      VALUES ('org-profiles', 'Profiles', 'profiles-migration');
      INSERT INTO harness_profiles
        (id, organization_id, slug, draft_manifest, created_by_id, updated_by_id)
      VALUES
        ('profile-1', 'org-profiles', 'profile-1', '{}'::jsonb, 'admin', 'admin');
      INSERT INTO harness_profile_versions
        (profile_id, version, manifest, manifest_hash, created_by_id)
      VALUES
        ('profile-1', 1, '{}'::jsonb, '${"a".repeat(64)}', 'admin');
      UPDATE harness_profiles SET published_version = 1 WHERE id = 'profile-1';
      INSERT INTO harness_skill_artifacts
        (organization_id, artifact_hash, name, source_owner, source_repository,
         source_path, source_commit_sha, created_by_id)
      VALUES
        ('org-profiles', '${"b".repeat(64)}', 'example', 'acme', 'skills',
         'example', '${"c".repeat(40)}', 'admin');
      INSERT INTO harness_skill_artifact_files
        (artifact_id, path, mode, size_bytes, sha256, content_base64)
      SELECT id, 'SKILL.md', 420, 3, '${"d".repeat(64)}', 'YWJj'
      FROM harness_skill_artifacts;
      INSERT INTO harness_profile_version_skills
        (profile_id, profile_version, artifact_id, skill_name, position)
      SELECT 'profile-1', 1, id, 'example', 0
      FROM harness_skill_artifacts;
    `);
    await expect(
      client.exec(`
        DELETE FROM harness_profile_versions
        WHERE profile_id = 'profile-1' AND version = 1
      `),
    ).rejects.toThrow();
    await expect(
      client.exec(`DELETE FROM harness_skill_artifacts`),
    ).rejects.toThrow();
  });

  it("upgrades 0022 data in place without backfilling historical runs", async () => {
    const client = await migrateThrough("0022");
    await client.exec(`
      INSERT INTO workflow_runs (run_id, status)
      VALUES ('legacy-profile-run', 'success')
    `);
    await client.exec(
      readFileSync(`${migrationsDir}0023_curious_miek.sql`, "utf8"),
    );

    const runs = await client.query<{
      run_id: string;
      status: string;
      harness_manifests: unknown;
    }>(`
      SELECT run_id, status, harness_manifests
      FROM workflow_runs
      WHERE run_id = 'legacy-profile-run'
    `);
    expect(runs.rows).toEqual([
      {
        run_id: "legacy-profile-run",
        status: "success",
        harness_manifests: null,
      },
    ]);
    const counts = await client.query<{ profiles: number; artifacts: number }>(`
      SELECT
        (SELECT count(*)::int FROM harness_profiles) AS profiles,
        (SELECT count(*)::int FROM harness_skill_artifacts) AS artifacts
    `);
    expect(counts.rows).toEqual([{ profiles: 0, artifacts: 0 }]);
  });
});
