/**
 * Clear run-registry entries in Neon Postgres.
 *
 *   pnpm exec tsx scripts/clear-run-registry.ts            # show state, no writes
 *   pnpm exec tsx scripts/clear-run-registry.ts AWT-42     # clear one ticket
 *   pnpm exec tsx scripts/clear-run-registry.ts --all --yes # clear every ticket
 */
import { config } from "dotenv";

// Load .env.local (where `vercel env pull` writes) before .env; dotenv never
// overrides vars already set, so real env (Vercel build) always wins.
config({ path: [".env.local", ".env"], quiet: true });

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}
const sql = neon(url);

const tables = {
  active: "active_runs",
  failed: "failed_tickets",
  threads: "thread_parents",
} as const;

async function dump() {
  for (const [label, table] of Object.entries(tables)) {
    const rows = await sql.query(`SELECT * FROM ${table}`);
    console.log(`\n[${label}] ${table}`);
    if (rows.length === 0) console.log("  (empty)");
    else for (const r of rows) console.log(`  ${JSON.stringify(r)}`);
  }
}

async function clearTicket(t: string) {
  for (const [label, table] of Object.entries(tables)) {
    const rows = await sql.query(
      `DELETE FROM ${table} WHERE ticket_key = $1 RETURNING ticket_key`,
      [t],
    );
    console.log(`  delete ${label} ${t} -> ${rows.length}`);
  }
}

async function clearAll() {
  for (const [label, table] of Object.entries(tables)) {
    const rows = await sql.query(`DELETE FROM ${table} RETURNING ticket_key`);
    console.log(`  delete all ${label} -> ${rows.length}`);
  }
}

const args = process.argv.slice(2);
(async () => {
  if (args.length === 0) {
    console.log("dumping current state (no writes)");
    await dump();
    return;
  }
  if (args[0] === "--all") {
    if (args.length !== 2 || args[1] !== "--yes") {
      console.error(
        "refusing to clear ALL run-registry tables without confirmation.\n" +
          "  re-run with: pnpm exec tsx scripts/clear-run-registry.ts --all --yes",
      );
      process.exit(1);
    }
    console.log("clearing ALL run-registry tables");
    await clearAll();
    return;
  }
  if (args.length !== 1) {
    console.error(`unexpected extra args: ${args.slice(1).join(" ")}`);
    process.exit(1);
  }
  console.log(`clearing ticket ${args[0]}`);
  await clearTicket(args[0]);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
