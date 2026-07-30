/**
 * Emits a data migration that re-syncs every platform-authored body of the
 * three built-in agent prompts in prompt_library_versions with
 * DEFAULT_AGENT_PROMPTS.
 *
 * Migration 0021 froze those bodies as SQL literals and nothing re-syncs them.
 * A run never reads the constant: a v2 workflow definition stores a pinned
 * {{prompt:<slug>@N}} token in its own JSON and resolvePromptReferencesForRun
 * serves whatever prompt_library_versions row that pin names. So every time the
 * constants change, the stored bodies go stale and runs keep serving the old
 * text. Two drift alarms go red when a new resync migration is needed:
 * src/prompt-library/store.test.ts (the seeded head) and
 * src/prompt-library/builtin-prompt-drift.test.ts (every version an active
 * definition actually pins).
 *
 * N is not always 1. The v1 to v2 migration canonicalizer
 * (src/workflow-definition/v2-migration-prompts.ts) and the flow editor both
 * pin the version that was current when the definition was saved, so this
 * migration must reach platform-authored versions above 1 as well.
 *
 * Usage, from apps/worker (build the shared package first, the bodies are read
 * from the built @shared/contracts the runtime itself consumes):
 *
 *   pnpm build:shared
 *   pnpm exec drizzle-kit generate --custom --name=builtin_prompt_resync
 *   pnpm exec tsx scripts/generate-builtin-prompt-resync-migration.ts \
 *     drizzle/<generated file>.sql
 *
 * Never point it at a migration that has already been applied anywhere: the
 * migration runner selects work by folderMillis, which is the `when` timestamp
 * in drizzle/meta/_journal.json, and never reads the stored hash, so a rewritten
 * file is silently not re-applied and the edit never reaches that database.
 * Always generate a fresh numbered file, and regenerate rather than renumber if
 * another branch lands a migration first: a `when` older than an already-applied
 * migration's is skipped just as silently.
 */
import { writeFileSync } from "node:fs";
import { DEFAULT_AGENT_PROMPTS } from "@shared/contracts";

/** Dollar-quote tag, so the bodies are copied verbatim instead of being escaped
 *  quote by quote. Verified absent from every body below. */
const TAG = "$aiw_prompt_resync$";
const BREAKPOINT = "--> statement-breakpoint";

/** The prompt_library.slug each constant belongs to. Slug is the immutable
 *  reference key {{prompt:<slug>@N}} resolves through, so it is what the guard
 *  matches on; name is user-visible and conceptually renameable. */
const SLUG_BY_PROMPT: Record<keyof typeof DEFAULT_AGENT_PROMPTS, string> = {
  "research-plan": "research-plan",
  implement: "implement",
  review: "review",
};

const HEADER = `-- Re-syncs the three built-in agent prompt bodies with the code constants in
-- apps/shared/contracts/default-prompts.ts (DEFAULT_AGENT_PROMPTS).
--
-- Migration 0021 froze those bodies as SQL literals in prompt_library_versions,
-- and only a resync migration like this one moves them. A v2 run never reads the
-- constant: the workflow definition stores a pinned {{prompt:<slug>@N}} token in
-- its own JSON and resolvePromptReferencesForRun serves whatever version row
-- that pin names. The constants have changed since the last resync, so every v2
-- run was being served prompt text that predates the change.
--
-- Why this supersedes 0034 and 0036: both restricted the update to version = 1
-- and additionally skipped a prompt entirely when any version above 1 existed.
-- Both premises were wrong. First, N is not always 1: the v1 to v2 migration
-- canonicalizer and the flow editor pin whichever version was current when the
-- definition was saved, so an active definition can pin @2. Second, "a version
-- above 1 exists" does not mean "a user edited this text", and that clause also
-- vetoed the correction of version 1 itself. On production the two clauses
-- together made 0034 and 0036 complete no-ops for "implement" and "review",
-- which both still held the original 0021 seed, while an active definition
-- pinned implement@2. Every prompt fix shipped since 0021 was therefore inert.
--
-- Guard: authorship is read off the version row itself instead of being inferred
-- from the prompt's version count. Migration 0021 and every resync stamp
-- created_by_id = 'system' and created_by_label = 'System migration', which
-- marks platform-shipped text, and this migration corrects every such row.
-- Customer text is never touched: the only application writers of
-- prompt_library_versions are createPrompt, savePromptVersion and
-- restorePromptVersion in apps/worker/src/prompt-library/store.ts, all reached
-- only through the role-gated dashboard routes, and all three stamp the
-- authenticated user's id and display label. A row a customer authored can
-- therefore never carry 'system', so a built-in a customer has forked keeps
-- every version it wrote, and an active definition that pins one of those keeps
-- resolving it. src/prompt-library/builtin-prompt-drift.ts reports that case
-- separately from drift.
--
-- The parent prompt row must still be the platform's own (system-created and not
-- archived), so a prompt a customer created that happens to reuse a built-in
-- slug is out of scope.
--
-- Each statement is standalone (no explicit transaction: neon-http has none) and
-- is a strict no-op when the body already matches.
--
-- Generated; do not hand-edit the bodies. Regenerate with
-- scripts/generate-builtin-prompt-resync-migration.ts (see its header).`;

/** One statement per prompt. The body literal is bound once through a CTE and
 *  read by both the SET and the no-op guard, so it is never duplicated. Every
 *  platform-authored version of the prompt is corrected, matched on the version
 *  row's own created_by columns, so a pin at @2 is reached and a version a
 *  customer wrote is not. The parent updated_at bump is chained off the RETURNING
 *  so it fires only when a row actually changed, mirroring what
 *  savePromptVersion writes. */
function buildStatement(slug: string, body: string): string {
  return `WITH "new_body" AS (
  SELECT ${TAG}${body}${TAG}::text AS "body"
), "corrected" AS (
  UPDATE "prompt_library_versions" AS "v"
  SET "body" = (SELECT "body" FROM "new_body")
  WHERE "v"."body" IS DISTINCT FROM (SELECT "body" FROM "new_body")
    AND "v"."created_by_id" = 'system'
    AND "v"."created_by_label" = 'System migration'
    AND "v"."prompt_id" IN (
      SELECT "p"."id"
      FROM "prompt_library" AS "p"
      WHERE "p"."slug" = '${slug}'
        AND "p"."created_by_id" = 'system'
        AND "p"."created_by_label" = 'System migration'
        AND "p"."archived_at" IS NULL
    )
  RETURNING "v"."prompt_id" AS "prompt_id"
)
UPDATE "prompt_library" AS "p"
SET "updated_at" = now()
WHERE "p"."id" IN (SELECT "prompt_id" FROM "corrected");`;
}

const target = process.argv[2];
if (!target) {
  console.error(
    "Usage: tsx scripts/generate-builtin-prompt-resync-migration.ts <output .sql path>",
  );
  process.exit(1);
}

const names = Object.keys(SLUG_BY_PROMPT) as (keyof typeof DEFAULT_AGENT_PROMPTS)[];
for (const name of names) {
  const body = DEFAULT_AGENT_PROMPTS[name];
  // A body containing the quote tag would end the literal early; one containing
  // the breakpoint marker would be split into two invalid statements.
  if (body.includes(TAG)) {
    throw new Error(`dollar-quote tag ${TAG} appears inside "${name}"`);
  }
  if (body.includes(BREAKPOINT)) {
    throw new Error(`statement breakpoint marker appears inside "${name}"`);
  }
  console.log(`${name}: ${Buffer.byteLength(body, "utf8")} bytes, quoting is safe`);
}

const statements = names.map((name) =>
  buildStatement(SLUG_BY_PROMPT[name], DEFAULT_AGENT_PROMPTS[name]),
);
const sql = `${HEADER}\n${statements.join(`\n${BREAKPOINT}\n`)}\n`;

writeFileSync(target, sql, "utf8");
console.log(`Wrote ${target} (${Buffer.byteLength(sql, "utf8")} bytes).`);
