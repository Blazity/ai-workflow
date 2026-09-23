import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { bulletsOf } from "../changelog/collate.ts";

/**
 * A pull request that changes what users get has to say so. This module holds
 * that rule as one pure decision plus a caller that gathers the facts, so the
 * rule can be tested by calling it rather than by reading the workflow file.
 */

/** Product code: a change under one of these owes the changelog an entry. */
const PRODUCT_PREFIXES = ["apps/", "packages/", "integrations/"] as const;
/** The trailing slash is load bearing: a directory, not a name prefix. */
const CHANGELOG_ENTRY_PREFIX = "changelog/unreleased/";
/** The human override. It is a deliberate opt out, not a default. */
const SKIP_LABEL = "changelog: skip";

/**
 * The one file status that disqualifies an entry.
 *
 * The REST "List pull requests files" endpoint gives every file a `status`
 * out of `added`, `removed`, `modified`, `renamed`, `copied`, `changed` or
 * `unchanged` (the diff-entry enum in the GitHub REST docs for that endpoint).
 * Sweeping this repository's own pull requests 415 to 484 turned up four of
 * the seven in the wild: `added` and `modified` everywhere, `removed` in 473,
 * 457 and 442, `renamed` in 424, 427, 428 and 429.
 *
 * `removed` is the whole reason the status is carried at all. The endpoint
 * lists a file a pull request DELETES exactly like one it adds, so a pull
 * request that deletes somebody else's pending entry and changes `apps/**`
 * used to satisfy this gate while shipping the reader nothing.
 *
 * The other six are deliberately not disqualifying:
 * - `renamed` keeps the file. `filename` is the name after the rename, so the
 *   entry still sits under changelog/unreleased/ and still collates; a rename
 *   out of that directory lands on a path that is not a candidate anyway.
 * - `modified` keeps the file. Adding a bullet to an entry that is already
 *   pending collation is a real way to document a change, and
 *   changelog/README.md forbids nothing of the sort.
 * - `copied`, `changed` and `unchanged` never appeared here. All three mean
 *   the file is on the merge ref, so the body below is what decides them.
 */
const REMOVED_STATUS = "removed";

/** One changed file, as the pull request's file list reports it. */
export interface ChangedFile {
  /**
   * The path. On the REST files endpoint this field is spelled `filename`,
   * never `path`.
   */
  readonly path: string;
  /** The status verbatim, as GitHub spells it. See REMOVED_STATUS. */
  readonly status: string;
  /**
   * The file's content on the merge ref, carried for candidate entry files
   * only. `null` means the caller tried to read it and could not, and
   * `undefined` means it was never read: every file outside
   * changelog/unreleased/, and every entry this pull request deletes.
   *
   * The body is a fact on the facts rather than a judgment in the caller
   * because "this entry says nothing" and "this gate could not see the entry"
   * are two different answers owing the author two different sentences, and
   * the seam that can be tested by calling it is this one. A caller that
   * collapsed them into a boolean would move both decisions back out into the
   * shell, where the only way to pin them is to read the workflow file.
   */
  readonly body?: string | null;
}

/** Everything the decision is allowed to see. */
export interface ChangelogEntryFacts {
  /**
   * Every file the pull request changes. Blank paths are kept on purpose: the
   * decision has to be able to tell "could not read" from "changed nothing",
   * and blanks are what a misread file list looks like.
   */
  readonly changedFiles: readonly ChangedFile[];
  /** The pull request's label names, verbatim. */
  readonly labels: readonly string[];
}

export type ChangelogEntryVerdict =
  | { readonly status: "pass" }
  | { readonly status: "skip"; readonly reason: string }
  | { readonly status: "fail"; readonly reason: string };

/**
 * The gate's whole decision. No network, no environment, no process exit.
 *
 * The label is read before the file list, so an explicit human opt out still
 * holds when the file list could not be read at all. Everything after it
 * fails closed: this gate exists to answer "does this change owe an entry",
 * and a gate that cannot see the change must not answer "no".
 *
 * Each way of failing closed gets its own sentence naming what was actually
 * seen, down to the offending file. The reader is a person whose pull request
 * just went red, and "the changelog check failed" tells them nothing they can
 * act on.
 */
export function changelogEntryVerdict(
  facts: ChangelogEntryFacts,
): ChangelogEntryVerdict {
  if (facts.labels.includes(SKIP_LABEL)) {
    return { status: "skip", reason: `Pull request labeled ${SKIP_LABEL}.` };
  }

  // Blank rather than empty, because asking an endpoint for a field the
  // response does not carry yields one empty path per file, which is not an
  // empty list. `gh pr view --json files` has the matching trap: it returns at
  // most 100 files, never paginates, and says nothing when it truncates. Every
  // fact below is derived from this list, so either misread breaks all of
  // them, and the direction of the breakage is the dangerous one: an
  // unreadable list reads as "touches nothing" and waves an unlogged product
  // change through. Reading no path is a failure to see the pull request,
  // never a pull request that changes nothing.
  const files = facts.changedFiles.filter((file) => file.path.trim().length > 0);
  if (files.length === 0) {
    return {
      status: "fail",
      reason:
        "Read no file paths for this pull request. Refusing to treat that as a pull request that touches no product code.",
    };
  }

  // Anchored at the start: `docs/apps/thing.md` is not a product change, and
  // `changelog/unreleased-notes.md` is not a changelog entry.
  const touchesProduct = files.some((file) =>
    PRODUCT_PREFIXES.some((prefix) => file.path.startsWith(prefix)),
  );
  if (!touchesProduct) {
    return { status: "pass" };
  }

  const candidates = files.filter((file) =>
    file.path.startsWith(CHANGELOG_ENTRY_PREFIX),
  );
  if (candidates.length === 0) {
    return {
      status: "fail",
      reason:
        "This pull request changes apps/**, packages/** or integrations/** but adds no file under changelog/unreleased/. Add an entry (see changelog/README.md) or apply the changelog: skip label.",
    };
  }

  // A file the pull request deletes is not an entry it adds, so it is out
  // before anything reads a body.
  const kept = candidates.filter((file) => file.status !== REMOVED_STATUS);

  // The gate's question is the collation's question, asked through the
  // collation's own predicate: does this entry put at least one line into
  // CHANGELOG.md. `bulletsOf` keeps the lines matching /^- /, which is the
  // shape changelog/README.md documents under "Adding an entry" ("one or two
  // Markdown bullets, no frontmatter, no heading"), so requiring it invents no
  // format. Importing it rather than restating it means the gate and the
  // collator cannot drift into disagreeing about what an entry is: a blank file
  // and a file of bullet-less prose both collate to nothing, and both fail here
  // for that one reason.
  //
  // This stays a pure call. `bulletsOf` is strings in, strings out; the node:fs
  // imports in collate.ts belong to its CLI path, which sits behind an argv
  // guard and never runs on import.
  const usable = kept.filter(
    (file) => typeof file.body === "string" && bulletsOf(file.body).length > 0,
  );
  if (usable.length > 0) {
    return { status: "pass" };
  }

  // Ranked before the blank case on purpose. "I could not read it" is not the
  // author's mistake and must not be reported as one.
  const unreadable = kept.filter((file) => typeof file.body !== "string");
  if (unreadable.length > 0) {
    return {
      status: "fail",
      reason: `This pull request changes apps/**, packages/** or integrations/** and this gate could not read ${list(unreadable)} from the checkout, so it cannot tell whether the entry says anything. Refusing to pass a product change on an entry it never saw.`,
    };
  }

  // Three things can be wrong with a candidate and each wants a different
  // remedy: restore the file, write something, or put a bullet in front of what
  // is already written. Passing or failing no longer separates blank from
  // bullet-less, because neither yields a line, but the author still has to be
  // told which of the two they are looking at.
  const seen = candidates.map((file) => {
    if (file.status === REMOVED_STATUS) {
      return `${file.path} is deleted by this pull request (status ${file.status})`;
    }
    return typeof file.body === "string" && file.body.trim().length > 0
      ? `${file.path} has text but no Markdown bullet`
      : `${file.path} is blank`;
  });
  return {
    status: "fail",
    reason: `This pull request changes apps/**, packages/** or integrations/** and leaves no changelog entry behind: ${seen.join(", ")}. An entry is one or two lines starting with "- " (see changelog/README.md); nothing else is collected into CHANGELOG.md. Add an entry or apply the changelog: skip label.`,
  };
}

function list(files: readonly ChangedFile[]): string {
  return files.map((file) => file.path).join(", ");
}

function gh(args: readonly string[]): string {
  return execFileSync("gh", [...args], { encoding: "utf8" });
}

function labelsOf(pullRequest: string): string[] {
  return gh(["pr", "view", pullRequest, "--json", "labels", "--jq", ".labels[].name"])
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * The body of one candidate entry, read from the checkout. This runs in the
 * `source-checks` job after `actions/checkout@v4`, which on a pull_request
 * event checks out the merge commit, so a file the pull request adds or
 * changes is on disk carrying the content the merge would ship.
 *
 * `null` on failure, never a throw and never a substituted empty string: an
 * unreadable entry is a fact the decision has to see, and the caller quietly
 * turning it into "" would report a broken checkout as an empty changelog
 * entry. The cause is printed so the log names it either way.
 */
function entryBodyOf(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    console.log(
      `::warning::Could not read ${path} from the checkout: ${(error as Error).message}`,
    );
    return null;
  }
}

/**
 * The paginated REST endpoint, because `gh pr view --json files` caps at 100
 * files without saying so. The field holding the path there is `filename`:
 * `.path` exists only on `gh pr view`, and asking this endpoint for it yields
 * one empty line per file. `@tsv` puts the path and its status on one line and
 * escapes any tab or newline inside a path, so no filename can knock the split
 * below out of alignment.
 *
 * A failed read returns no files rather than throwing, so the verdict, not the
 * plumbing, decides what an unreadable file list means. The cause is printed
 * first so the log names it.
 *
 * Bodies are read for candidate entries only, never for all 126 paths of a
 * pull request. A candidate the pull request deletes is not on the merge ref,
 * so there is nothing to read; the decision turns it down on its status before
 * it ever looks for a body.
 */
function changedFilesOf(repository: string, pullRequest: string): ChangedFile[] {
  let lines: string[];
  try {
    lines = gh([
      "api",
      "--paginate",
      `repos/${repository}/pulls/${pullRequest}/files`,
      "--jq",
      ".[] | [.filename, .status] | @tsv",
    ]).split("\n");
  } catch (error) {
    console.log(
      `::warning::Could not list the files of pull request ${pullRequest}: ${(error as Error).message}`,
    );
    return [];
  }

  return lines.map((line) => {
    const [path = "", status = ""] = line.split("\t");
    if (path.startsWith(CHANGELOG_ENTRY_PREFIX) && status !== REMOVED_STATUS) {
      return { path, status, body: entryBodyOf(path) };
    }
    return { path, status };
  });
}

function main(): void {
  if (process.env.EVENT_NAME !== "pull_request") {
    console.log("::notice::Not a pull request event, skipping the changelog check.");
    return;
  }
  if (process.env.HEAD_IS_FORK === "true") {
    console.log("::notice::Fork pull request, skipping the changelog check.");
    return;
  }
  const pullRequest = process.env.PR_NUMBER ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!pullRequest || !repository) {
    console.log(
      "::error::PR_NUMBER and GITHUB_REPOSITORY must both be set on a pull request event.",
    );
    process.exitCode = 1;
    return;
  }

  let labels: string[];
  try {
    labels = labelsOf(pullRequest);
  } catch (error) {
    // Without the labels the opt out cannot be honoured, so there is no
    // verdict to reach: this one stays a hard failure.
    console.log(
      `::error::Could not read the labels of pull request ${pullRequest}: ${(error as Error).message}`,
    );
    process.exitCode = 1;
    return;
  }

  const verdict = changelogEntryVerdict({
    changedFiles: changedFilesOf(repository, pullRequest),
    labels,
  });
  if (verdict.status === "skip") {
    console.log(`::notice::${verdict.reason}`);
    return;
  }
  if (verdict.status === "fail") {
    console.log(`::error::${verdict.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log("changelog check passed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
