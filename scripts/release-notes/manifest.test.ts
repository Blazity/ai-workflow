import assert from "node:assert/strict";
import test from "node:test";

import { validateApprovedSourceRelease } from "./manifest.js";
import { renderReleaseNotes } from "./render.js";
import { collection } from "./test-fixtures.js";

const candidate = "d".repeat(40);
const featureCommit = "c".repeat(40);
const notesPath = "docs/releases/artur/2026.08.0.md";
const markdown = renderReleaseNotes(
  collection,
  {
    highlights: "Update",
    features: [{ text: "Teams can use GitLab repositories.", sources: [7] }],
    improvementsAndFixes: [],
    requiredAction: "None.",
    knownLimitations: "None.",
    generatedBy: "fallback",
  },
  "2026.08.0",
);

function reviewedPullRequest() {
  return {
    number: 42,
    state: "MERGED",
    mergedAt: "2026-08-03T09:00:00Z",
    mergeCommit: { oid: candidate },
    baseRefName: "main",
    reviewDecision: "APPROVED",
    files: [{ path: notesPath }],
  };
}

// The reviews are read from their own paginated endpoint, so a test that does
// not answer it never reaches the approver list.
function isReviewsRead(command: string, args: string[]): boolean {
  return command === "gh" && args.some((arg) => arg.includes("/pulls/42/reviews"));
}

function reviewPages(...pages: Array<Array<{ state: string; user: { login: string } | null }>>) {
  return JSON.stringify(pages);
}

function collectedPullRequest() {
  return {
    number: 7,
    title: "feat: GitLab support",
    body: "## User impact\nGitLab repositories work.\n## Release note\nUse GitLab repositories.",
    labels: [{ name: "release:feature" }],
    merged_at: "2026-07-30T10:00:00Z",
    merge_commit_sha: featureCommit,
    html_url: "https://github.com/Blazity/ai-workflow/pull/7",
  };
}

test("validates an approved source release while main advances past the pinned target", async () => {
  const run = async (command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "show") return markdown;
    if (args[0] === "rev-parse") return args[2].startsWith("a") ? "a".repeat(40) : "b".repeat(40);
    if (args[0] === "rev-list") return featureCommit;
    if (isReviewsRead(command, args)) {
      return reviewPages([{ state: "APPROVED", user: { login: "zak" } }]);
    }
    if (command === "gh" && args[0] === "api" && args.includes("--paginate")) {
      return JSON.stringify([[collectedPullRequest()]]);
    }
    if (command === "gh" && args[0] === "api") return JSON.stringify([{ number: 42 }]);
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      return JSON.stringify(reviewedPullRequest());
    }
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  const result = await validateApprovedSourceRelease(
    { version: "2026.08.0", markdown, mainRef: "main" },
    { run },
  );
  assert.equal(result.targetSourceCommit, "b".repeat(40));
  assert.equal(result.previousSourceCommit, "a".repeat(40));
  assert.equal(result.releaseNotesPullRequest, 42);
  assert.deepEqual(result.releaseNotesApprovedBy, ["zak"]);
});

test("rejects release notes whose exact scope omits a pull request from the Git range", async () => {
  const incompleteMarkdown = markdown
    .replace(
      "- Teams can use GitLab repositories.\n  <!-- sources: 7 -->",
      "No new user-facing capabilities in this release.",
    )
    .replace(
      "- [#7](https://github.com/Blazity/ai-workflow/pull/7) — feature: feat: GitLab support",
      "No included pull requests.",
    );
  const run = async (command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "show") return incompleteMarkdown;
    if (args[0] === "rev-parse") return args[2].startsWith("a") ? "a".repeat(40) : "b".repeat(40);
    if (args[0] === "rev-list") return featureCommit;
    if (args[0] === "diff") return notesPath;
    if (args[0] === "tag") return "";
    if (isReviewsRead(command, args)) {
      return reviewPages([{ state: "APPROVED", user: { login: "zak" } }]);
    }
    if (command === "gh" && args[0] === "api" && args.includes("--paginate")) {
      return JSON.stringify([[collectedPullRequest()]]);
    }
    if (command === "gh" && args[0] === "api") return JSON.stringify([{ number: 42 }]);
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      return JSON.stringify(reviewedPullRequest());
    }
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(
    validateApprovedSourceRelease(
      { version: "2026.08.0", markdown: incompleteMarkdown, mainRef: "main" },
      { run },
    ),
    /exact release scope does not match/i,
  );
});

test("rejects a release-note pull request that changes a second file", async () => {
  const run = async (command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "show") return markdown;
    if (command === "gh" && args[0] === "api") return JSON.stringify([{ number: 42 }]);
    if (command === "gh" && args[0] === "pr") {
      return JSON.stringify({
        ...reviewedPullRequest(),
        files: [{ path: notesPath }, { path: "apps/worker/src/index.ts" }],
      });
    }
    return "";
  };
  await assert.rejects(
    validateApprovedSourceRelease({ version: "2026.08.0", markdown, mainRef: "main" }, { run }),
    /not docs-only/,
  );
});

test("rejects release notes edited after the reviewed candidate", async () => {
  const run = async (_command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "show") return `${markdown}\nChanged later.\n`;
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(
    validateApprovedSourceRelease({ version: "2026.08.0", markdown, mainRef: "main" }, { run }),
    /differ from the reviewed candidate/i,
  );
});

test("rejects a release range whose previous commit is not an ancestor of the target", async () => {
  const run = async (_command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base" && args[3] === "main") return "";
    if (args[0] === "merge-base") throw new Error("not an ancestor");
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(
    validateApprovedSourceRelease({ version: "2026.08.0", markdown, mainRef: "main" }, { run }),
    /previousSourceCommit is not an ancestor of targetSourceCommit/,
  );
});

test("rejects a candidate without an approved docs-only pull request", async () => {
  const run = async (command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "show") return markdown;
    if (args[0] === "diff") return notesPath;
    if (args[0] === "tag") return "";
    if (command === "gh" && args[0] === "api") return JSON.stringify([{ number: 42 }]);
    if (command === "gh" && args[0] === "pr") {
      return JSON.stringify({ ...reviewedPullRequest(), reviewDecision: "REVIEW_REQUIRED" });
    }
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(
    validateApprovedSourceRelease({ version: "2026.08.0", markdown, mainRef: "main" }, { run }),
    /approved review/,
  );
});

test("rejects a release-note file added directly to main", async () => {
  const run = async (command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "show") return markdown;
    if (args[0] === "diff") return notesPath;
    if (args[0] === "tag") return "";
    if (command === "gh" && args[0] === "api") return "[]";
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(
    validateApprovedSourceRelease({ version: "2026.08.0", markdown, mainRef: "main" }, { run }),
    /exactly one merged pull request, but GitHub associates 0 with/,
  );
});

// The candidate's pull requests arrive one page at a time. A page that came
// back full is a read that stopped, not a count, and the refusal has to say so
// rather than report the page size as the number of pull requests.
test("refuses a candidate whose pull-request list fills a page instead of naming the page size", async () => {
  const run = async (command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "show") return markdown;
    if (command === "gh" && args[0] === "api") {
      assert.match(args[1], /per_page=100/, "the page size has to be asked for, not inherited");
      return JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })));
    }
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(
    validateApprovedSourceRelease({ version: "2026.08.0", markdown, mainRef: "main" }, { run }),
    /Cannot count the pull requests introducing release candidate .* filled its page of 100/s,
  );
});

test("names how many pull requests GitHub associates with a candidate it cannot release", async () => {
  const run = async (command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "show") return markdown;
    if (command === "gh" && args[0] === "api") {
      return JSON.stringify([{ number: 42 }, { number: 43 }]);
    }
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  await assert.rejects(
    validateApprovedSourceRelease({ version: "2026.08.0", markdown, mainRef: "main" }, { run }),
    /exactly one merged pull request, but GitHub associates 2 with/,
  );
});

// `gh pr view --json reviews` stops at 100 reviews without saying so, and the
// approver list it feeds is the release record. An approver on the second page
// has to reach that record.
test("records an approver who reviewed past the first page of reviews", async () => {
  const run = async (command: string, args: string[]) => {
    if (args[0] === "log") return candidate;
    if (args[0] === "merge-base") return "";
    if (args[0] === "show") return markdown;
    if (args[0] === "rev-parse") return args[2].startsWith("a") ? "a".repeat(40) : "b".repeat(40);
    if (args[0] === "rev-list") return featureCommit;
    if (isReviewsRead(command, args)) {
      assert.ok(args.includes("--paginate"), "the review read has to page through every review");
      return reviewPages(
        [{ state: "COMMENTED", user: { login: "bot" } }],
        [{ state: "APPROVED", user: { login: "mira" } }],
      );
    }
    if (command === "gh" && args[0] === "api" && args.includes("--paginate")) {
      return JSON.stringify([[collectedPullRequest()]]);
    }
    if (command === "gh" && args[0] === "api") return JSON.stringify([{ number: 42 }]);
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      assert.ok(
        !args.at(-1)?.includes("reviews"),
        "reviews must not be read through the capped pull-request view",
      );
      return JSON.stringify(reviewedPullRequest());
    }
    throw new Error(`Unexpected: ${args.join(" ")}`);
  };
  const result = await validateApprovedSourceRelease(
    { version: "2026.08.0", markdown, mainRef: "main" },
    { run },
  );
  assert.deepEqual(result.releaseNotesApprovedBy, ["mira"]);
});
