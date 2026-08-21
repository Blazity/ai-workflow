import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import type { WorkflowDefinitionV2 } from "@shared/contracts";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";
import { workflowDefinitionTemplate } from "./templates.js";
import { validateWorkflowDefinitionCandidate } from "./validation.js";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
  webhookTriggerConfigured: true,
};

const OLD_INSTRUCTIONS =
  "Resolve the fetched pull-request review feedback or failing checks, verify the fix, and commit the resulting changes.";
const AUTOFIX_COMMENT_MIGRATION = "0056_autofix_comment_binding";

async function migrateThrough(lastPrefix: string): Promise<PGlite> {
  const client = new PGlite();
  for (const file of migrationFiles) {
    if (file.slice(0, 4) > lastPrefix) break;
    await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  }
  return client;
}

async function applyAutofixCommentBinding(client: PGlite): Promise<void> {
  const file = migrationFiles.find((name) => name.startsWith(AUTOFIX_COMMENT_MIGRATION));
  if (!file) throw new Error(`${AUTOFIX_COMMENT_MIGRATION} migration not found`);
  await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
}

async function deployDefinition(
  client: PGlite,
  name: string,
  definition: unknown,
): Promise<number> {
  const created = await client.query<{ id: number }>(
    `INSERT INTO workflow_definitions (name, enabled, trigger_types, created_by_id, created_by_label)
     VALUES ($1, false, '{}', 'u_admin', 'Admin') RETURNING id`,
    [name],
  );
  const id = created.rows[0]!.id;
  await client.query(
    `INSERT INTO workflow_definition_versions (definition_id, version, definition, created_by_id, created_by_label)
     VALUES ($1, 1, $2, 'u_admin', 'Admin')`,
    [id, JSON.stringify(definition)],
  );
  await client.query(`UPDATE workflow_definitions SET deployed_version = 1 WHERE id = $1`, [id]);
  return id;
}

async function readStoredDefinition(client: PGlite, id: number): Promise<unknown> {
  const rows = await client.query<{ definition: unknown }>(
    `SELECT definition FROM workflow_definition_versions WHERE definition_id = $1 AND version = 1`,
    [id],
  );
  return rows.rows[0]!.definition;
}

function currentFixTemplate(): WorkflowDefinitionV2 {
  const template = workflowDefinitionTemplate("review-fix-after-pr", {
    includeReview: true,
    provider: "claude",
  });
  if (!template || template.definition.schemaVersion !== 2) {
    throw new Error("The Fix template must use schema version 2");
  }
  return template.definition;
}

/** What the same template produced before the summary was wired into the
 *  comment, which is what every definition deployed until now still stores. */
function deployedBeforeTheFix(): WorkflowDefinitionV2 {
  const definition = JSON.parse(JSON.stringify(currentFixTemplate())) as WorkflowDefinitionV2;
  for (const node of definition.nodes) {
    if (node.id === "comment") node.inputs = {};
    if (node.id === "fix") node.configuration.instructions = OLD_INSTRUCTIONS;
  }
  return definition;
}

describe("0056 auto-fix comment binding", () => {
  it("brings a definition deployed before the fix up to the current template", async () => {
    const client = await migrateThrough("0055");
    const before = deployedBeforeTheFix();
    const id = await deployDefinition(client, "PR checks failed autofix", before);

    await applyAutofixCommentBinding(client);

    const after = await readStoredDefinition(client, id);
    expect(after).toEqual(currentFixTemplate());
    expect(
      validateWorkflowDefinitionCandidate(after, registryContext).response.valid,
    ).toBe(true);
  });

  it("changes nothing on a second application", async () => {
    const client = await migrateThrough("0055");
    const id = await deployDefinition(client, "PR checks failed autofix", deployedBeforeTheFix());

    await applyAutofixCommentBinding(client);
    const once = await readStoredDefinition(client, id);
    await applyAutofixCommentBinding(client);
    const twice = await readStoredDefinition(client, id);

    expect(twice).toEqual(once);
  });

  it("leaves a customized comment body byte for byte", async () => {
    const client = await migrateThrough("0055");
    const customized = deployedBeforeTheFix();
    customized.nodes.find((node) => node.id === "comment")!.configuration.body =
      "Our bot pushed a fix.";
    const id = await deployDefinition(client, "Customized autofix", customized);

    await applyAutofixCommentBinding(client);

    // The instructions are left alone too: a graph whose comment somebody edited
    // is not ours to rewrite, in either place.
    expect(await readStoredDefinition(client, id)).toEqual(customized);
  });

  it("leaves a rewired graph alone rather than binding an unreachable reference", async () => {
    const client = await migrateThrough("0055");
    const rewired = deployedBeforeTheFix();
    // The pre-PR checks node is gone, so fix no longer reaches comment through
    // the backbone the guard recognizes.
    rewired.nodes = rewired.nodes.filter((node) => node.id !== "checks");
    rewired.edges = rewired.edges
      .filter((edge) => edge.to !== "checks" && edge.from !== "checks")
      .concat([{ id: "rewired-fix-out-finalize", from: "fix", to: "finalize" }]);
    const id = await deployDefinition(client, "Rewired autofix", rewired);

    await applyAutofixCommentBinding(client);

    expect(await readStoredDefinition(client, id)).toEqual(rewired);
  });

  it("corrects every stored version, not only the deployed one", async () => {
    const client = await migrateThrough("0055");
    const id = await deployDefinition(client, "PR checks failed autofix", deployedBeforeTheFix());
    await client.query(
      `INSERT INTO workflow_definition_versions (definition_id, version, definition, created_by_id, created_by_label)
       VALUES ($1, 2, $2, 'u_admin', 'Admin')`,
      [id, JSON.stringify(deployedBeforeTheFix())],
    );

    await applyAutofixCommentBinding(client);

    const rows = await client.query<{ version: number; definition: unknown }>(
      `SELECT version, definition FROM workflow_definition_versions
       WHERE definition_id = $1 ORDER BY version`,
      [id],
    );
    expect(rows.rows.map((row) => row.version)).toEqual([1, 2]);
    for (const row of rows.rows) expect(row.definition).toEqual(currentFixTemplate());
  });
});
