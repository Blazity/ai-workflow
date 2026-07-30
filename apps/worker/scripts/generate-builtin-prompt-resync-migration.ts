/**
 * Emits a data migration that re-syncs the three built-in agent prompt bodies
 * in prompt_library_versions version 1 with DEFAULT_AGENT_PROMPTS.
 *
 * Migration 0021 froze those bodies as SQL literals and nothing re-syncs them,
 * while the default v2 workflow definition pins {{prompt:<slug>@1}}. So every
 * time the constants change, the stored version-1 bodies go stale and runs keep
 * serving the old text. src/prompt-library/store.test.ts is the drift alarm: it
 * asserts the seeded bodies are byte-identical to the constants, so it goes red
 * exactly when a new resync migration is needed.
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
 *  reference key {{prompt:<slug>@1}} resolves through, so it is what the guard
 *  matches on; name is user-visible and conceptually renameable. */
const SLUG_BY_PROMPT: Record<keyof typeof DEFAULT_AGENT_PROMPTS, string> = {
  "research-plan": "research-plan",
  implement: "implement",
  review: "review",
};

const HEADER = `-- Re-syncs the three built-in agent prompt bodies with the code constants in
-- apps/shared/contracts/default-prompts.ts (DEFAULT_AGENT_PROMPTS).
--
-- Migration 0021 froze those bodies as SQL literals in prompt_library_versions
-- version 1, and only a resync migration like this one moves them. The default
-- v2 workflow definition pins {{prompt:research-plan@1}},
-- {{prompt:implement@1}} and {{prompt:review@1}}, so every v2 run resolves the
-- stored version-1 body and never reads the constant. The constants have
-- changed since the last resync, so every v2 run was being served prompt text
-- that predates the change.
--
-- Version 1 is corrected IN PLACE rather than superseded by a version 2: every
-- workflow definition already stored carries the "@1" pin inside its own JSON,
-- so a new version would not reach any existing definition. Version 1 of a
-- built-in prompt means "what the platform ships", so correcting it is right.
--
-- Guard: only rows that are still the untouched platform seed are touched. Every
-- write path in apps/worker/src/prompt-library/store.ts is append-only
-- (createPrompt inserts version 1 for a new prompt, savePromptVersion and
-- restorePromptVersion both INSERT max+1); there is no UPDATE or DELETE against
-- prompt_library_versions anywhere in the codebase. A prompt whose head is still
-- version 1 therefore provably carries the original seeded body, so "seeded by
-- the system migration, not archived, and with no version above 1" is exactly
-- "never edited by a user". A prompt a user has edited keeps its own version 1
-- untouched and is skipped.
--
-- A deployment whose admin ever saved a version of a built-in is therefore
-- skipped for good: its version 1 keeps the older body, its stored definitions
-- still pin "@1", and no later resync reaches it either, which is the price of
-- never clobbering text a customer wrote.
--
-- Each statement is standalone (no explicit transaction: neon-http has none) and
-- is a strict no-op when the body already matches.
--
-- Generated; do not hand-edit the bodies. Regenerate with
-- scripts/generate-builtin-prompt-resync-migration.ts (see its header).`;

/** One statement per prompt. The body literal is bound once through a CTE and
 *  read by both the SET and the no-op guard, so it is never duplicated. The
 *  parent updated_at bump is chained off the RETURNING so it fires only for a
 *  row that actually changed, mirroring what savePromptVersion writes. */
function buildStatement(slug: string, body: string): string {
  return `WITH "new_body" AS (
  SELECT ${TAG}${body}${TAG}::text AS "body"
), "corrected" AS (
  UPDATE "prompt_library_versions" AS "v"
  SET "body" = (SELECT "body" FROM "new_body")
  WHERE "v"."version" = 1
    AND "v"."body" IS DISTINCT FROM (SELECT "body" FROM "new_body")
    AND "v"."prompt_id" IN (
      SELECT "p"."id"
      FROM "prompt_library" AS "p"
      WHERE "p"."slug" = '${slug}'
        AND "p"."created_by_id" = 'system'
        AND "p"."created_by_label" = 'System migration'
        AND "p"."archived_at" IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "prompt_library_versions" AS "newer"
      WHERE "newer"."prompt_id" = "v"."prompt_id"
        AND "newer"."version" > 1
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
