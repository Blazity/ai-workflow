/**
 * One-shot setup: ensures the Arthur prompt-host task exists and has the three
 * workflow prompts seeded with the `production` tag.
 *
 *   npx tsx scripts/setup-arthur-prompts.ts
 *
 * Requires in .env:
 *   GENAI_ENGINE_API_KEY
 *   GENAI_ENGINE_TRACE_ENDPOINT
 *
 * Prints the task UUID as a paste-ready env line at the end.
 */
import "dotenv/config";
import { ArthurClient } from "../src/sandbox/arthur-client.js";
import { PROMPT_FALLBACKS, PROMPT_NAMES } from "../src/lib/prompts.js";

const TASK_NAME = "ai-workflow-prompts";
const TAG = "production";

const apiKey = process.env.GENAI_ENGINE_API_KEY;
const endpoint = process.env.GENAI_ENGINE_TRACE_ENDPOINT;
if (!apiKey || !endpoint) {
  console.error("Missing GENAI_ENGINE_{API_KEY,TRACE_ENDPOINT} in env/.env");
  process.exit(1);
}

const modelName = process.env.CLAUDE_MODEL ?? "claude-opus-4-6";
const client = ArthurClient.fromTraceEndpoint(endpoint, apiKey);

async function main() {
  let task = await client.findTaskByName(TASK_NAME);
  if (task) {
    console.log(`Found existing task "${TASK_NAME}" (${task.id}) — will overwrite prompts.`);
  } else {
    task = await client.createPlainTask(TASK_NAME);
    console.log(`Created new task "${TASK_NAME}" (${task.id}).`);
  }

  const failures: string[] = [];
  for (const name of PROMPT_NAMES) {
    const body = PROMPT_FALLBACKS[name];
    console.log(`\n  seeding ${name}…`);
    try {
      const created = await client.createPromptVersion(task.id, name, body, { modelName });
      const version = created.version;
      if (version === undefined) {
        console.error(`  no version returned; cannot tag. full response:`, created);
        failures.push(name);
        continue;
      }
      await client.tagPromptVersion(task.id, name, version, TAG);
      console.log(`  ✓ version ${version} tagged "${TAG}"`);
    } catch (err) {
      console.error(`  failed to seed "${name}":`, err instanceof Error ? err.message : err);
      failures.push(name);
    }
  }

  if (failures.length > 0) {
    console.error(
      `\nSetup FAILED for task ${task.id}. Affected prompts: ${failures.join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`\nSetup complete. Add this to .env:\n  GENAI_ENGINE_PROMPT_TASK_ID=${task.id}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
