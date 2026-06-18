import { neon } from "@neondatabase/serverless";

/**
 * e2e preflight: confirm DATABASE_URL points at a Neon branch that has the
 * orchestration tables. A reachable-but-unmigrated database almost always
 * means the e2e DATABASE_URL is the WRONG branch — it must be the branch the
 * deployment under test (ai-workflow-demo) uses. Catching it here turns the
 * confusing assertion/timeout failures (the deployed app and the test writing
 * to different branches) into one clear, early error.
 *
 * Note: this proves the URL reaches a migrated DB, not that it is the SAME
 * branch the deployment uses — two migrated branches are indistinguishable
 * from here. It only rules out the unmigrated / wrong-DB case.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const required = ["active_runs", "failed_tickets"];
const sql = neon(url);

try {
  const rows = await sql`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `;
  const found = new Set(rows.map((r) => r.table_name as string));
  const missing = required.filter((t) => !found.has(t));
  if (missing.length > 0) {
    console.error(
      `DB preflight FAILED: DATABASE_URL reaches a database missing table(s): ${missing.join(", ")}.\n` +
        `The e2e DATABASE_URL is almost certainly the wrong Neon branch — it must be the branch the\n` +
        `deployment under test (ai-workflow-demo) uses, with migrations applied.`,
    );
    process.exit(1);
  }
  console.log(`DB preflight OK — found tables: ${required.join(", ")}`);
} catch (err) {
  console.error(
    `DB preflight FAILED to query DATABASE_URL: ${(err as Error).message}`,
  );
  process.exit(1);
}
