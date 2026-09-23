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

describe("0072 integrations contract migration", () => {
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

    await client.exec(readFileSync(`${migrationsDir}0072_integrations_contract.sql`, "utf8"));

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
    // Production is neon-http, which cannot open an interactive transaction,
    // and drizzle sends this file one statement at a time, so its statements do
    // not succeed or fail together: any of them can commit and the next fail on
    // a dropped network connection. Every statement here is therefore written
    // to survive its own retry, because the worker's build runs the migrations
    // and a file that cannot be applied twice stops the next deploy dead.
    const client = await migrateBeforeProviderConstraintDrop();
    const migration = readFileSync(`${migrationsDir}0072_integrations_contract.sql`, "utf8");
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
