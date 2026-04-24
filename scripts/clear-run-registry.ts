/**
 * Clear run-registry entries in Upstash.
 *
 *   pnpm exec tsx scripts/clear-run-registry.ts            # show state, no writes
 *   pnpm exec tsx scripts/clear-run-registry.ts AWT-42     # clear one ticket
 *   pnpm exec tsx scripts/clear-run-registry.ts --all      # clear every ticket in this env
 */
import "dotenv/config";
import { Redis } from "@upstash/redis";

const ENV_PREFIX = process.env.VERCEL_ENV ?? "development";
const keys = {
  active: `blazebot:active-runs:${ENV_PREFIX}`,
  sandbox: `blazebot:sandboxes:${ENV_PREFIX}`,
  entryTs: `blazebot:entry-timestamps:${ENV_PREFIX}`,
  failed: `blazebot:failed-tickets:${ENV_PREFIX}`,
};

const url = process.env.AI_WORKFLOW_KV_REST_API_URL;
const token = process.env.AI_WORKFLOW_KV_REST_API_TOKEN;
if (!url || !token) {
  console.error("Missing AI_WORKFLOW_KV_REST_API_URL / AI_WORKFLOW_KV_REST_API_TOKEN");
  process.exit(1);
}
const redis = new Redis({ url, token });

async function dump() {
  for (const [label, key] of Object.entries(keys)) {
    const all = await redis.hgetall<Record<string, string>>(key);
    console.log(`\n[${label}] ${key}`);
    if (!all || Object.keys(all).length === 0) console.log("  (empty)");
    else for (const [t, v] of Object.entries(all)) console.log(`  ${t} -> ${v}`);
  }
}

async function clearTicket(t: string) {
  for (const [label, key] of Object.entries(keys)) {
    const n = await redis.hdel(key, t);
    console.log(`  hdel ${label} ${t} -> ${n}`);
  }
}

async function clearAll() {
  for (const [label, key] of Object.entries(keys)) {
    const n = await redis.del(key);
    console.log(`  del ${label} ${key} -> ${n}`);
  }
}

const args = process.argv.slice(2);
(async () => {
  if (args.length === 0) {
    console.log(`env=${ENV_PREFIX} — dumping current state (no writes)`);
    await dump();
    return;
  }
  if (args[0] === "--all") {
    if (args.length !== 2 || args[1] !== "--yes") {
      console.error(
        `env=${ENV_PREFIX} — refusing to clear ALL run-registry keys without confirmation.\n` +
          `  re-run with: pnpm exec tsx scripts/clear-run-registry.ts --all --yes`,
      );
      process.exit(1);
    }
    console.log(`env=${ENV_PREFIX} — clearing ALL run-registry keys`);
    await clearAll();
    return;
  }
  if (args.length !== 1) {
    console.error(`env=${ENV_PREFIX} — unexpected extra args: ${args.slice(1).join(" ")}`);
    process.exit(1);
  }
  console.log(`env=${ENV_PREFIX} — clearing ticket ${args[0]}`);
  await clearTicket(args[0]);
})().catch((e) => { console.error(e); process.exit(1); });
