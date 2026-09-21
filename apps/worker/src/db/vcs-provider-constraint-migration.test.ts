import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

async function migrateBeforeProviderConstraintDrop(): Promise<PGlite> {
  const client = new PGlite();
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql") && file.slice(0, 4) < "0072")
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  }
  return client;
}

describe("0072 open VCS provider migration", () => {
  it("keeps existing meanings and lets registry validation own new provider ids", async () => {
    const client = await migrateBeforeProviderConstraintDrop();
    await client.exec(`
      INSERT INTO repositories (provider, path, source)
      VALUES ('github', 'acme/api', 'imported');
      INSERT INTO workflow_owned_branches (ticket_key, provider, repo_path, branch_name)
      VALUES ('AWT-72', 'gitlab', 'acme/web', 'ai/AWT-72');
    `);
    await expect(
      client.exec(`INSERT INTO repositories (provider, path, source) VALUES ('forgejo', 'acme/new', 'imported')`),
    ).rejects.toThrow();

    await client.exec(readFileSync(`${migrationsDir}0072_open_vcs_providers.sql`, "utf8"));

    await client.exec(`
      INSERT INTO repositories (provider, path, source)
      VALUES ('forgejo', 'acme/new', 'imported');
      INSERT INTO workflow_owned_branches (ticket_key, provider, repo_path, branch_name)
      VALUES ('AWT-73', 'forgejo', 'acme/new', 'ai/AWT-73');
    `);
    const repositories = await client.query<{ provider: string; path: string }>(
      `SELECT provider, path FROM repositories ORDER BY id`,
    );
    const branches = await client.query<{ ticket_key: string; provider: string }>(
      `SELECT ticket_key, provider FROM workflow_owned_branches ORDER BY ticket_key`,
    );
    expect(repositories.rows).toEqual([
      { provider: "github", path: "acme/api" },
      { provider: "forgejo", path: "acme/new" },
    ]);
    expect(branches.rows).toEqual([
      { ticket_key: "AWT-72", provider: "gitlab" },
      { ticket_key: "AWT-73", provider: "forgejo" },
    ]);
  });

  it("can be applied again after a half-applied attempt", async () => {
    // Production is neon-http, which cannot open an interactive transaction, so
    // this file's two drops do not succeed or fail together: the first can
    // commit and the second fail on a dropped network connection. Without
    // `IF EXISTS` the retry dies on the constraint the first attempt already
    // removed, and the migration can never be applied again on that database.
    const client = await migrateBeforeProviderConstraintDrop();
    const migration = readFileSync(`${migrationsDir}0072_open_vcs_providers.sql`, "utf8");
    await client.exec(migration);

    await expect(client.exec(migration)).resolves.toBeDefined();

    await client.exec(
      `INSERT INTO repositories (provider, path, source) VALUES ('forgejo', 'acme/new', 'imported')`,
    );
    const repositories = await client.query<{ provider: string }>(
      `SELECT provider FROM repositories`,
    );
    expect(repositories.rows).toEqual([{ provider: "forgejo" }]);
  });
});
