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

const [arg] = process.argv.slice(2);
(async () => {
  if (!arg) {
    console.log(`env=${ENV_PREFIX} — dumping current state (no writes)`);
    await dump();
    return;
  }
  if (arg === "--all") {
    console.log(`env=${ENV_PREFIX} — clearing ALL run-registry keys`);
    await clearAll();
    return;
  }
  console.log(`env=${ENV_PREFIX} — clearing ticket ${arg}`);
  await clearTicket(arg);
})().catch((e) => { console.error(e); process.exit(1); });
