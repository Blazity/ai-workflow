/**
 * Smoke test for ArthurClient.ensureTaskForTicket against a live engine.
 *   npx tsx scripts/test-arthur-ensure.ts <ticket-identifier>
 */
import "dotenv/config";
import { ArthurClient } from "../src/sandbox/arthur-client.js";

async function main() {
  const identifier = process.argv[2];
  if (!identifier) {
    console.error("Usage: npx tsx scripts/test-arthur-ensure.ts <ticket-id>");
    process.exit(1);
  }
  const apiKey = process.env.GENAI_ENGINE_API_KEY;
  const endpoint = process.env.GENAI_ENGINE_TRACE_ENDPOINT;
  if (!apiKey || !endpoint) {
    console.error("Missing GENAI_ENGINE_API_KEY / GENAI_ENGINE_TRACE_ENDPOINT");
    process.exit(1);
  }

  const client = ArthurClient.fromTraceEndpoint(endpoint, apiKey);
  const existing = await client.findTicketTasks(identifier);
  console.log(`Existing tasks matching "${identifier}(.N)?":`);
  for (const t of existing) console.log(`  ${t.id}  ${t.name}`);

  const task = await client.ensureTaskForTicket(identifier);
  console.log(`\nCreated: ${task.id}  name="${task.name}"`);
}

main().catch((e) => { console.error(e); process.exit(1); });
