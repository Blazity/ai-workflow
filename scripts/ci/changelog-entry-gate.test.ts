import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { bulletsOf } from "../changelog/collate.ts";
import {
  changelogEntryVerdict,
  type ChangedFile,
} from "./changelog-entry-gate.ts";

const ENTRY = "changelog/unreleased/work-scope-record.md";
const BODY = "- Workflow runs now record the repository they worked in.\n";

/** A changed file that is not a changelog entry, so no body is ever read. */
function changed(path: string, status = "modified"): ChangedFile {
  return { path, status };
}

/** A changelog entry, with the body the caller read off the merge ref. */
function entry(
  path: string,
  body: string | null,
  status = "added",
): ChangedFile {
  return { path, status, body };
}

function reasonOf(verdict: ReturnType<typeof changelogEntryVerdict>): string {
  return verdict.status === "pass" ? "" : verdict.reason;
}

test("a product change carrying an entry passes", () => {
  assert.deepEqual(
    changelogEntryVerdict({
      changedFiles: [
        changed("apps/worker/src/engine/steps/call-llm.ts"),
        entry(ENTRY, BODY),
      ],
      labels: [],
    }),
    { status: "pass" },
  );
});

test("a packages change with no entry fails and names what to add", () => {
  const verdict = changelogEntryVerdict({
    changedFiles: [changed("packages/workflow-graph/index.ts")],
    labels: [],
  });

  assert.equal(verdict.status, "fail");
  assert.match(
    reasonOf(verdict),
    /adds no file under changelog\/unreleased\/.*changelog\/README\.md.*changelog: skip/u,
  );
});

test("an integrations change with no entry fails and names what to add", () => {
  const verdict = changelogEntryVerdict({
    changedFiles: [changed("integrations/gitlab/webhook.ts")],
    labels: [],
  });

  assert.equal(verdict.status, "fail");
  assert.match(
    reasonOf(verdict),
    /adds no file under changelog\/unreleased\/.*changelog\/README\.md.*changelog: skip/u,
  );
});

test("a change that touches no product code passes without an entry", () => {
  assert.deepEqual(
    changelogEntryVerdict({
      changedFiles: [changed("docs/index.md"), changed(".github/workflows/ci.yml")],
      labels: [],
    }),
    { status: "pass" },
  );
});

test("the skip label skips a product change with no entry, and says so", () => {
  assert.deepEqual(
    changelogEntryVerdict({
      changedFiles: [changed("apps/dashboard/app/page.tsx")],
      labels: ["dependencies", "changelog: skip"],
    }),
    { status: "skip", reason: "Pull request labeled changelog: skip." },
  );
});

/**
 * The label is the human override, and it is read before anything else. A
 * gate that could not see the pull request at all must still honour it, or an
 * outage of the files endpoint turns an explicit opt out into a red check
 * nobody can clear.
 */
test("the skip label overrides an unreadable file list and an unreadable entry", () => {
  assert.deepEqual(
    changelogEntryVerdict({ changedFiles: [], labels: ["changelog: skip"] }),
    { status: "skip", reason: "Pull request labeled changelog: skip." },
  );
  assert.deepEqual(
    changelogEntryVerdict({
      changedFiles: [changed("apps/worker/src/index.ts"), entry(ENTRY, null)],
      labels: ["changelog: skip"],
    }),
    { status: "skip", reason: "Pull request labeled changelog: skip." },
  );
});

/**
 * The two that matter. A gate answering "this pull request touches no product
 * code" when it means "I could not read what this pull request touches" is
 * permanently green, and the direction of that mistake waves unlogged product
 * changes through. Both shapes of an unread file list must fail, and the
 * message must say the paths could not be read.
 */
test("an empty file list fails, because it means the paths could not be read", () => {
  const verdict = changelogEntryVerdict({ changedFiles: [], labels: [] });

  assert.equal(verdict.status, "fail");
  assert.match(reasonOf(verdict), /Read no file paths/u);
  assert.doesNotMatch(
    reasonOf(verdict),
    /adds no file under/u,
    "the reason must be the unread list, not a missing entry",
  );
});

test("a list of blank paths fails the same way, which is what asking for a field the response does not carry produces", () => {
  // `gh api .../files --jq '.[] | [.path, .status] | @tsv'` yields an empty
  // first column per file: 126 changed files arrive as 126 blank paths, which
  // is not an empty list and which every prefix test below would read as
  // "changes nothing".
  const verdict = changelogEntryVerdict({
    changedFiles: [
      changed(""),
      changed(""),
      changed(""),
      changed("  "),
      changed(""),
    ],
    labels: [],
  });

  assert.equal(verdict.status, "fail");
  assert.match(reasonOf(verdict), /Read no file paths/u);
});

test("a path that merely contains apps/ deeper in it is not a product change", () => {
  assert.deepEqual(
    changelogEntryVerdict({
      changedFiles: [
        changed("docs/apps/thing.md"),
        changed("e2e/packages/fixture.ts"),
        changed("scripts/ci/apps/helper.ts"),
      ],
      labels: [],
    }),
    { status: "pass" },
  );
});

test("changelog/unreleased is matched as a directory, so a lookalike file does not satisfy it", () => {
  const verdict = changelogEntryVerdict({
    changedFiles: [
      changed("apps/worker/src/index.ts"),
      entry("changelog/unreleased-notes.md", BODY),
    ],
    labels: [],
  });

  assert.equal(verdict.status, "fail");
  assert.match(reasonOf(verdict), /adds no file under/u);
});

test("a file directly under changelog/unreleased satisfies the entry", () => {
  assert.deepEqual(
    changelogEntryVerdict({
      changedFiles: [changed("packages/costs/index.ts"), entry("changelog/unreleased/a.md", BODY)],
      labels: [],
    }),
    { status: "pass" },
  );
});

/**
 * The gate used to decide from paths alone, so it proved a filename existed
 * and nothing else. The REST files endpoint lists a file a pull request
 * DELETES exactly like one it adds; only `status` separates them. A pull
 * request that drops somebody else's pending entry and changes `apps/**` was
 * green while the reader of CHANGELOG.md lost a line.
 */
test("deleting somebody else's entry does not count as carrying one", () => {
  const verdict = changelogEntryVerdict({
    changedFiles: [
      changed("apps/worker/src/index.ts"),
      { path: ENTRY, status: "removed" },
    ],
    labels: [],
  });

  assert.equal(verdict.status, "fail");
  assert.match(
    reasonOf(verdict),
    /leaves no changelog entry behind.*changelog\/unreleased\/work-scope-record\.md is deleted by this pull request \(status removed\)/u,
    "the refusal has to name the file and what was seen of it",
  );
  assert.match(reasonOf(verdict), /changelog\/README\.md.*changelog: skip/u);
});

/**
 * A body carried into the decision cannot be faked by a status: a caller that
 * never read the file and a pull request that really deleted it must not
 * arrive at the same answer by accident.
 */
test("a removed entry stays removed even when a body comes with it", () => {
  const verdict = changelogEntryVerdict({
    changedFiles: [
      changed("apps/worker/src/index.ts"),
      entry(ENTRY, BODY, "removed"),
    ],
    labels: [],
  });

  assert.equal(verdict.status, "fail");
  assert.match(reasonOf(verdict), /is deleted by this pull request \(status removed\)/u);
});

/**
 * An entry with nothing in it collates to nothing, so the gate proved a
 * filename and the reader of CHANGELOG.md got nothing.
 */
test("an empty entry file does not count as an entry", () => {
  const verdict = changelogEntryVerdict({
    changedFiles: [changed("apps/worker/src/index.ts"), entry(ENTRY, "")],
    labels: [],
  });

  assert.equal(verdict.status, "fail");
  assert.match(
    reasonOf(verdict),
    /leaves no changelog entry behind: changelog\/unreleased\/work-scope-record\.md is blank/u,
  );
});

/**
 * The same defect wearing prose. `bulletsOf` collects only lines matching
 * /^- /, so an entry of bullet-less prose reaches CHANGELOG.md as nothing, just
 * like an empty file. The author's words exist, which is exactly why the
 * refusal has to say the shape is wrong rather than that the file is empty.
 */
test("an entry with text but no bullet does not count, and the refusal names the shape", () => {
  const verdict = changelogEntryVerdict({
    changedFiles: [
      changed("apps/worker/src/index.ts"),
      entry(ENTRY, "The dashboard has a new Repositories page.\n"),
    ],
    labels: [],
  });

  assert.equal(verdict.status, "fail");
  assert.match(
    reasonOf(verdict),
    /changelog\/unreleased\/work-scope-record\.md has text but no Markdown bullet/u,
  );
  assert.match(
    reasonOf(verdict),
    /one or two lines starting with "- ".*changelog\/README\.md/u,
    "the documented shape has to be named, or the author cannot act on this",
  );
  assert.doesNotMatch(
    reasonOf(verdict),
    /is blank/u,
    "their words are there; calling the file blank sends them to fix the wrong thing",
  );
});

/**
 * One authority, two callers. The gate does not hold a second opinion about
 * what an entry is: whatever `bulletsOf` collects is what satisfies the gate,
 * so the two cannot drift.
 */
test("the gate agrees with bulletsOf on every body, because it asks bulletsOf", () => {
  const bodies = [
    "",
    "   \n\t\n",
    "The dashboard has a new Repositories page.\n",
    "# Heading\n\nSome prose.\n",
    "* Not a Markdown bullet by this collator's rule.\n",
    "-no space after the dash\n",
    "- A real bullet.\n",
    "  - An indented bullet, which bulletsOf trims before matching.\n",
    "Prose first.\n- Then a bullet.\n",
  ];

  for (const body of bodies) {
    const verdict = changelogEntryVerdict({
      changedFiles: [changed("apps/worker/src/index.ts"), entry(ENTRY, body)],
      labels: [],
    });
    assert.equal(
      verdict.status === "pass",
      bulletsOf(body).length > 0,
      `gate and bulletsOf disagree on ${JSON.stringify(body)}`,
    );
  }
});

test("a whitespace-only entry file does not count as an entry", () => {
  const verdict = changelogEntryVerdict({
    changedFiles: [
      changed("packages/contracts/index.ts"),
      entry(ENTRY, "\n\n   \t\n"),
    ],
    labels: [],
  });

  assert.equal(verdict.status, "fail");
  assert.match(reasonOf(verdict), /is blank/u);
  assert.doesNotMatch(
    reasonOf(verdict),
    /could not read/u,
    "a blank entry was read; saying it could not be is a different failure",
  );
});

test("one blank entry alongside one real entry passes", () => {
  assert.deepEqual(
    changelogEntryVerdict({
      changedFiles: [
        changed("apps/dashboard/app/page.tsx"),
        entry("changelog/unreleased/blank.md", "   \n"),
        entry("changelog/unreleased/real.md", BODY),
      ],
      labels: [],
    }),
    { status: "pass" },
  );
});

test("one removed entry alongside one real entry passes", () => {
  assert.deepEqual(
    changelogEntryVerdict({
      changedFiles: [
        changed("apps/dashboard/app/page.tsx"),
        { path: "changelog/unreleased/somebody-else.md", status: "removed" },
        entry("changelog/unreleased/mine.md", BODY),
      ],
      labels: [],
    }),
    { status: "pass" },
  );
});

/**
 * An entry whose body never arrived is the gate's own failure, not the
 * author's, and the two owe different sentences. Telling somebody their entry
 * is blank when the checkout is what broke sends them to edit a file that is
 * already correct.
 */
test("an entry whose body could not be read fails in its own words", () => {
  const verdict = changelogEntryVerdict({
    changedFiles: [changed("apps/worker/src/index.ts"), entry(ENTRY, null)],
    labels: [],
  });

  assert.equal(verdict.status, "fail");
  assert.match(
    reasonOf(verdict),
    /could not read changelog\/unreleased\/work-scope-record\.md from the checkout/u,
  );
  assert.doesNotMatch(
    reasonOf(verdict),
    /is blank|adds no file under/u,
    "an unreadable entry is neither a blank one nor a missing one",
  );
});

test("an unreadable entry is reported as unreadable even next to a blank one", () => {
  const verdict = changelogEntryVerdict({
    changedFiles: [
      changed("apps/worker/src/index.ts"),
      entry("changelog/unreleased/blank.md", ""),
      entry("changelog/unreleased/unreadable.md", null),
    ],
    labels: [],
  });

  assert.equal(verdict.status, "fail");
  assert.match(
    reasonOf(verdict),
    /could not read changelog\/unreleased\/unreadable\.md from the checkout/u,
  );
});

/**
 * Every way of failing closed says something different about what was seen.
 * The last three share the one branch that decides pass or fail, and still say
 * three different things, because "I deleted yours", "mine is empty" and "mine
 * is prose" are three different mistakes.
 */
test("the six refusals are six distinct sentences", () => {
  const product = changed("apps/worker/src/index.ts");
  const reasons = [
    changelogEntryVerdict({ changedFiles: [], labels: [] }),
    changelogEntryVerdict({ changedFiles: [product], labels: [] }),
    changelogEntryVerdict({
      changedFiles: [product, entry(ENTRY, null)],
      labels: [],
    }),
    changelogEntryVerdict({
      changedFiles: [product, { path: ENTRY, status: "removed" }],
      labels: [],
    }),
    changelogEntryVerdict({
      changedFiles: [product, entry(ENTRY, "")],
      labels: [],
    }),
    changelogEntryVerdict({
      changedFiles: [product, entry(ENTRY, "Prose with no bullet.\n")],
      labels: [],
    }),
  ].map(reasonOf);

  assert.equal(new Set(reasons).size, 6, reasons.join("\n"));
  assert.ok(reasons.every((reason) => reason.length > 0));
});

test("the real pull request 484 file list passes: 126 files, one entry", async () => {
  // The list this gate failed while it read `gh pr view --json files`, which
  // caps at 100 and sorts the entry past the cap. Regenerated verbatim from
  // the command the caller runs, so path and status stay paired as GitHub
  // reports them.
  const fixture = await readFile(
    "scripts/ci/fixtures/pull-request-484-files.tsv",
    "utf8",
  );
  const changedFiles: ChangedFile[] = fixture
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [path = "", status = ""] = line.split("\t");
      return path.startsWith("changelog/unreleased/")
        ? { path, status, body: BODY }
        : { path, status };
    });

  assert.equal(changedFiles.length, 126);
  assert.deepEqual(
    changedFiles.filter((file) => file.path === ENTRY),
    [{ path: ENTRY, status: "added", body: BODY }],
  );
  assert.deepEqual(changelogEntryVerdict({ changedFiles, labels: [] }), {
    status: "pass",
  });
  // The first 100 files alone, which is all the capped call ever saw.
  assert.equal(
    changelogEntryVerdict({ changedFiles: changedFiles.slice(0, 100), labels: [] })
      .status,
    "fail",
    "the cap hid the entry; that is the failure this gate shape removes",
  );
});

test("the gate reads the file list from the paginated endpoint, never from the capped one", async () => {
  const source = await readFile("scripts/ci/changelog-entry-gate.ts", "utf8");
  const calls = source.replace(/^\s*(\/\/|\*|\/\*).*$/gmu, "");

  assert.match(
    calls,
    /"api",\s*"--paginate",\s*`repos\/\$\{repository\}\/pulls\/\$\{pullRequest\}\/files`,\s*"--jq",\s*"\.\[\] \| \[\.filename, \.status\] \| @tsv",/u,
    "the file list must come from the paginated REST endpoint, whose path field is `filename`, and must carry the status beside it",
  );
  assert.doesNotMatch(
    calls,
    /"pr",\s*"view",[^)]*"files"/u,
    "`gh pr view --json files` returns at most 100 files and never says so",
  );
});
