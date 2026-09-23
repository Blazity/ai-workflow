import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { engineCanaryScope } from "./engine-canary-scope.ts";

/**
 * SETUP.md keeps its own copy of the engine canary's prefix list, because the
 * person reading it is configuring a deployment and deserves the answer where
 * they already are rather than a pointer to a source file. A copy is also how
 * that list drifted: the source gained seven prefixes and the prose had no way
 * to notice. These tests hold the copy level with the source.
 *
 * They pin no wording. The prose may say whatever it likes as long as it names
 * every prefix the code selects on.
 */
const SETUP_DOC = "SETUP.md";
const SETUP_SECTION_HEADING = "### Engine canary (on demand)";
const SCOPE_SOURCE = "scripts/ci/engine-canary-scope.ts";

/**
 * Paths this section names in `apps/worker/src/` that are deliberately not
 * canary prefixes. One entry, and it is the boundary itself: the section says
 * that exactly three directories out of the wider services tree select the
 * canary, which it cannot say without naming the tree.
 */
const DOCUMENTED_NON_PREFIXES = new Set(["apps/worker/src/services/"]);

/**
 * The gate's section of SETUP.md, from its heading to the next heading of the
 * same or higher level. Reading the whole file instead would let a prefix
 * mentioned anywhere by coincidence satisfy the check. A renamed heading fails
 * here rather than quietly handing back an empty string, which would turn every
 * assertion below into a pass.
 */
async function behaviouralGateSection(): Promise<string> {
  const source = await readFile(SETUP_DOC, "utf8");
  const start = source.indexOf(`\n${SETUP_SECTION_HEADING}\n`);
  assert.notEqual(
    start,
    -1,
    `${SETUP_DOC} must carry the heading "${SETUP_SECTION_HEADING}". This test reads that section; if the heading was renamed, update the constant rather than leaving the test reading nothing`,
  );
  const body = source.slice(start + SETUP_SECTION_HEADING.length + 2);
  const end = body.search(/^#{1,3} /mu);
  const section = end === -1 ? body : body.slice(0, end);
  assert.ok(
    section.trim().length > 0,
    `the "${SETUP_SECTION_HEADING}" section of ${SETUP_DOC} is empty`,
  );
  return section;
}

/**
 * The prefix list, read out of its own source. It is parsed rather than
 * imported so the source needs no export that exists only for a test, and the
 * parse is then checked against the function it claims to describe: every
 * prefix it returns must actually select the canary, and every line of the
 * declaration must have been understood. A reformatting this parse cannot read
 * fails here instead of silently yielding a shorter list that every assertion
 * below would pass.
 */
async function canaryPrefixes(): Promise<string[]> {
  const source = await readFile(SCOPE_SOURCE, "utf8");
  const declaration = /const CANARY_PREFIXES = \[(?<body>[\s\S]*?)\] as const;/u.exec(
    source,
  );
  assert.ok(
    declaration?.groups?.body,
    `${SCOPE_SOURCE} must declare CANARY_PREFIXES as an array literal ending in "] as const;". This test reads that declaration and must refuse rather than pass when it cannot find it`,
  );

  const body = declaration.groups.body;
  const entries = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
  const prefixes = entries.map((line) => {
    const entry = /^"(?<prefix>[^"]+)",$/u.exec(line);
    assert.ok(
      entry?.groups?.prefix,
      `${SCOPE_SOURCE}: every non comment line of CANARY_PREFIXES must be one quoted prefix, found ${line}`,
    );
    return entry.groups.prefix;
  });
  assert.ok(prefixes.length > 0, `${SCOPE_SOURCE} declares no canary prefixes`);

  for (const prefix of prefixes) {
    assert.equal(
      engineCanaryScope([prefix]).run,
      true,
      `parsed prefix ${prefix} does not select the canary, so this parse does not describe the real list`,
    );
  }
  return prefixes;
}

/** `apps/worker/src/engine/**` and `scripts/ci/engine-canary*` both name a prefix. */
function withoutGlob(token: string): string {
  return token.replace(/\*+$/u, "");
}

function backtickedTokens(section: string): string[] {
  return [...section.matchAll(/`(?<token>[^`\n]+)`/gu)].map(
    (match) => match.groups!.token,
  );
}

test("SETUP.md names every prefix that selects the engine canary", async () => {
  const section = await behaviouralGateSection();
  const prefixes = await canaryPrefixes();
  const missing = prefixes.filter((prefix) => !section.includes(prefix));

  assert.deepEqual(
    missing,
    [],
    `the "${SETUP_SECTION_HEADING}" section of ${SETUP_DOC} does not name ${missing.join(", ")}. A prefix in the code that the document does not name tells a reader deciding on the run-canary label that their change does not need the canary when it does`,
  );
});

/**
 * The same lie pointing the other way, which is what a deleted entry leaves
 * behind: the document goes on promising cover the code no longer gives.
 *
 * The gap, named on purpose: this runs over `apps/worker/src/` paths only. The
 * section also names `apps/worker/drizzle/**` (the migration skip),
 * `docs/releases/...`, `/health`, `/mcp` and bare directory names, none of
 * which are prefixes and none of which are lies, so a rule over every path-like
 * token would fail on ordinary prose. Within `apps/worker/src/` the section has
 * no reason to name a path except to say the canary covers it, so there the
 * check is exact.
 */
test("SETUP.md claims no worker source cover the engine canary does not give", async () => {
  const section = await behaviouralGateSection();
  const prefixes = new Set(await canaryPrefixes());
  const claimed = backtickedTokens(section)
    .map(withoutGlob)
    .filter((token) => token.startsWith("apps/worker/src/"));

  assert.ok(
    claimed.length > 0,
    `the "${SETUP_SECTION_HEADING}" section names no worker source path, so this check is running against nothing`,
  );

  const unbacked = [
    ...new Set(
      claimed.filter(
        (token) => !prefixes.has(token) && !DOCUMENTED_NON_PREFIXES.has(token),
      ),
    ),
  ];
  assert.deepEqual(
    unbacked,
    [],
    `the "${SETUP_SECTION_HEADING}" section of ${SETUP_DOC} names ${unbacked.join(", ")}, which no longer selects the engine canary. Either put it back in ${SCOPE_SOURCE} or stop promising it here`,
  );
});
