import { describe, expect, it } from "vitest";
import { SCRUB_PLACEHOLDER, scrubForPublication } from "./publication-scrub.js";

/** The template the agent summary is interpolated into for an opened PR. */
function prBody(summary: string): string {
  return [
    "**Ticket:** [AWP-32](https://jira.example.com/browse/AWP-32)",
    "",
    "## What changed",
    summary,
  ].join("\n");
}

describe("publication scrub, on sentences published to real pull requests", () => {
  it("drops a sentence that reports writing the session memory document", () => {
    const summary =
      "I added the theme toggle, updated session memory at " +
      "`blazebot/memory/AWP-32.md`, and created commit `e0d3e72`.";

    expect(scrubForPublication(prBody(summary))).toBe(
      [
        "**Ticket:** [AWP-32](https://jira.example.com/browse/AWP-32)",
        "",
        "## What changed",
      ].join("\n"),
    );
  });

  it("drops both the memory document path and the platform's commit restriction", () => {
    const summary =
      "The toggle persists across reloads. Updated `blazebot/memory/AWP-33.md` " +
      "in the workspace; it remains uncommitted because the platform blocks " +
      "committing files under `blazebot/memory`.";

    expect(scrubForPublication(prBody(summary))).toBe(
      [
        "**Ticket:** [AWP-32](https://jira.example.com/browse/AWP-32)",
        "",
        "## What changed",
        "The toggle persists across reloads.",
      ].join("\n"),
    );
  });

  it("drops absolute sandbox paths and the claim that nothing was published", () => {
    const summary =
      "The parser now accepts trailing commas. The work is committed locally on " +
      "`ai-workflow/awp-30` in both repos (`995bfe6` in `/vercel/sandbox`, " +
      "`0beac33` in `/vercel/sandbox/repos/github__blazity__ai-workflow-prod`). " +
      "Per the workflow's Do Not Publish rule, no push or PR creation was attempted.";

    expect(scrubForPublication(prBody(summary))).toBe(
      [
        "**Ticket:** [AWP-32](https://jira.example.com/browse/AWP-32)",
        "",
        "## What changed",
        "The parser now accepts trailing commas.",
      ].join("\n"),
    );
  });

  it("drops the denial that contradicts the pull request it is printed in", () => {
    const summary =
      "Session memory was overwritten in `blazebot/memory/AWP-28.md`; the platform " +
      "blocks committing that path. I did not push or open a PR because this " +
      "sandbox workflow explicitly forbids publish actions. The retry budget is " +
      "now read from the run config.";

    expect(scrubForPublication(prBody(summary))).toBe(
      [
        "**Ticket:** [AWP-32](https://jira.example.com/browse/AWP-32)",
        "",
        "## What changed",
        "The retry budget is now read from the run config.",
      ].join("\n"),
    );
  });
});

describe("publication scrub, on legitimate content", () => {
  it("keeps a summary that is about the memory directory as code under change", () => {
    // This repository implements the memory directory, so the directory named on
    // its own is ordinary vocabulary and must survive untouched.
    const body = prBody(
      "Changed how `blazebot/memory` is excluded from the published commit range, " +
        "and added a regression test for the exclusion.",
    );

    expect(scrubForPublication(body)).toBe(body);
  });

  it("keeps a sentence about publication behaviour of the code under change", () => {
    const body = prBody(
      "The workflow now prevents duplicate PR creation when a webhook replays.",
    );

    expect(scrubForPublication(body)).toBe(body);
  });

  it("passes text with no platform vocabulary through byte-identical", () => {
    const body = prBody(
      "Added a `--dry-run` flag to the seed script (see `docs/seed.md`).\n" +
        "\n" +
        "- Reads config from `.env.local`\n" +
        "- Exits 1 on a missing table; exits 0 otherwise\n",
    );

    const scrubbed = scrubForPublication(body);
    expect(scrubbed).toBe(body);
    expect([...scrubbed]).toEqual([...body]);
  });

  it("keeps the surviving bullets of a list and drops only the leaking one", () => {
    expect(
      scrubForPublication(
        [
          "- Added the toggle.",
          "- Updated `blazebot/memory/AWP-32.md`.",
          "- Ran the unit tests.",
        ].join("\n"),
      ),
    ).toBe(["- Added the toggle.", "- Ran the unit tests."].join("\n"));
  });
});

describe("publication scrub, failure and emptiness", () => {
  it("never blocks publication and never publishes the unscrubbed text on failure", () => {
    const hostile = {
      toString: () => "committed in /vercel/sandbox",
      split: () => {
        throw new Error("scrub blew up");
      },
    } as unknown as string;

    expect(scrubForPublication(hostile)).toBe(SCRUB_PLACEHOLDER);
  });

  it("substitutes a placeholder when scrubbing empties the whole text", () => {
    expect(
      scrubForPublication("Updated `blazebot/memory/AWP-32.md` in the workspace."),
    ).toBe(SCRUB_PLACEHOLDER);
  });

  it("leaves an empty input empty", () => {
    expect(scrubForPublication("")).toBe("");
  });
});
