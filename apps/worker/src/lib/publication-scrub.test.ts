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

/**
 * The same template after scrubbing. An empty survivor list means the section was
 * emptied, and the body must not end on a heading with nothing under it.
 */
function scrubbedPrBody(survivors: string[]): string {
  return [
    "**Ticket:** [AWP-32](https://jira.example.com/browse/AWP-32)",
    "",
    "## What changed",
    ...(survivors.length > 0 ? survivors : [SCRUB_PLACEHOLDER]),
  ].join("\n");
}

/**
 * Hard-wraps prose on spaces, the way an agent's own multi-line summary arrives.
 * Agent text is not pre-joined anywhere: pr-external-resources builds
 * "- ${feedback}" straight out of the model's output.
 */
function wrapAt(text: string, width: number): string {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") current = word;
    else if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.join("\n");
}

interface PublishedSummary {
  label: string;
  summary: string;
  /** The lines that must survive under the heading, in order. */
  survivors: string[];
}

/**
 * Four sentences taken verbatim from real agent-authored pull request bodies in
 * this repository, where an audit found 13 of 14 leaking platform detail.
 */
const PUBLISHED_SUMMARIES: readonly PublishedSummary[] = [
  {
    label: "reports writing the session memory document",
    summary:
      "I added the theme toggle, updated session memory at " +
      "`blazebot/memory/AWP-32.md`, and created commit `e0d3e72`.",
    survivors: [],
  },
  {
    label: "names the memory document and the platform's commit restriction",
    summary:
      "The toggle persists across reloads. Updated `blazebot/memory/AWP-33.md` " +
      "in the workspace; it remains uncommitted because the platform blocks " +
      "committing files under `blazebot/memory`.",
    survivors: ["The toggle persists across reloads."],
  },
  {
    label: "names absolute sandbox paths and claims nothing was published",
    summary:
      "The parser now accepts trailing commas. The work is committed locally on " +
      "`ai-workflow/awp-30` in both repos (`995bfe6` in `/vercel/sandbox`, " +
      "`0beac33` in `/vercel/sandbox/repos/github__blazity__ai-workflow-prod`). " +
      "Per the workflow's Do Not Publish rule, no push or PR creation was attempted.",
    survivors: ["The parser now accepts trailing commas."],
  },
  {
    label: "denies the publication it is printed in",
    summary:
      "Session memory was overwritten in `blazebot/memory/AWP-28.md`; the platform " +
      "blocks committing that path. I did not push or open a PR because this " +
      "sandbox workflow explicitly forbids publish actions. The retry budget is " +
      "now read from the run config.",
    survivors: ["The retry budget is now read from the run config."],
  },
];

for (const fixture of PUBLISHED_SUMMARIES) {
  describe(`publication scrub, on a real summary that ${fixture.label}`, () => {
    it("removes the leaking sentences and keeps the rest", () => {
      expect(scrubForPublication(prBody(fixture.summary))).toBe(
        scrubbedPrBody(fixture.survivors),
      );
    });

    it("removes the same sentences when the agent wrapped them at 72 columns", () => {
      // One wrapped newline used to fall inside a marker's bounded window and
      // publish the whole sentence, or truncate the line in front of it.
      const wrapped = wrapAt(fixture.summary, 72);
      expect(wrapped.split("\n").length).toBeGreaterThan(1);

      expect(scrubForPublication(prBody(wrapped))).toBe(
        scrubbedPrBody(fixture.survivors),
      );
    });
  });
}

describe("publication scrub, on wrapped agent prose", () => {
  it("keeps the feedback sentence that a wrapped newline used to truncate", () => {
    // The exact shape pr-external-resources builds for review feedback.
    const feedback =
      "- The change is sound. I recorded the outcome in\n" +
      "  `blazebot/memory/AWP-32.md` before reviewing.";

    expect(scrubForPublication(feedback)).toBe("- The change is sound.");
  });

  it("drops only the leaking bullet when bullets wrap onto continuation lines", () => {
    expect(
      scrubForPublication(
        [
          "- Added the toggle so the",
          "  preference persists.",
          "- Updated session memory for",
          "  this task.",
          "- Ran the unit tests.",
        ].join("\n"),
      ),
    ).toBe(
      [
        "- Added the toggle so the",
        "  preference persists.",
        "- Ran the unit tests.",
      ].join("\n"),
    );
  });
});

describe("publication scrub, on rewordings that name no path", () => {
  it.each([
    [
      "a bare report that the memory document was written",
      "Session memory has been updated for this task.",
    ],
    [
      "the memory document named by its role",
      "The memory document for this task was overwritten in the workspace.",
    ],
    [
      "a denial of publication with no PR noun in it",
      "I did not publish anything, so read the branch directly.",
    ],
    ["publication scoped to the run", "Publishing was out of scope for this run."],
  ])("removes %s", (_label, sentence) => {
    expect(scrubForPublication(sentence)).toBe(SCRUB_PLACEHOLDER);
  });

  it("removes both halves of a two-sentence reworded report", () => {
    expect(
      scrubForPublication(
        "Session memory was overwritten. I stopped short of publishing " +
          "anything from this run.",
      ),
    ).toBe(SCRUB_PLACEHOLDER);
  });

  it("removes the publication claim from a sentence pair it does not own", () => {
    // "Committed locally in both repos." survives: no marker keys on a local
    // commit, and one that did would fire on ordinary PR bodies in this
    // repository.
    expect(
      scrubForPublication(
        "Committed locally in both repos. Publishing was out of scope for this run.",
      ),
    ).toBe("Committed locally in both repos.");
  });
});

describe("publication scrub, on fenced content", () => {
  it("keeps a quoted diff intact, delimiters and file headers included", () => {
    const body = [
      "Rejected this hunk:",
      "",
      "```diff",
      "--- a/blazebot/memory/AWP-32.md",
      "+++ b/blazebot/memory/AWP-32.md",
      "-old line",
      "+new line",
      "```",
      "",
      "Tests pass.",
    ].join("\n");

    expect(scrubForPublication(body)).toBe(body);
  });

  it("never removes an opening fence and leaves its partner behind", () => {
    // Without fence tracking the opening delimiter went and everything after the
    // block rendered as code in the customer's pull request.
    const body = ["```text /vercel/sandbox", "log body", "```", "Tests pass."].join(
      "\n",
    );

    expect(scrubForPublication(body)).toBe(body);
  });

  it("still scrubs the prose that follows a closed fence", () => {
    expect(
      scrubForPublication(
        [
          "```",
          "log line",
          "```",
          "Updated `blazebot/memory/AWP-32.md`.",
          "Tests pass.",
        ].join("\n"),
      ),
    ).toBe(["```", "log line", "```", "Tests pass."].join("\n"));
  });
});

describe("publication scrub, on the residue of a removed sentence", () => {
  it("never publishes a bare list enumerator", () => {
    expect(
      scrubForPublication(
        [
          "1. Added the toggle.",
          "2. Updated `blazebot/memory/AWP-32.md`.",
          "3. Ran the tests.",
        ].join("\n"),
      ),
    ).toBe(["1. Added the toggle.", "3. Ran the tests."].join("\n"));
  });

  it("does not split a sentence at an abbreviation", () => {
    expect(
      scrubForPublication("Ran the suite, e.g. Updated `blazebot/memory/AWP-32.md`."),
    ).toBe(SCRUB_PLACEHOLDER);
  });

  it("does not split a sentence at a name initial", () => {
    expect(
      scrubForPublication(
        "Reviewed with J. Smith before updating `blazebot/memory/AWP-32.md`.",
      ),
    ).toBe(SCRUB_PLACEHOLDER);
  });
});

describe("publication scrub, on an emptied section", () => {
  it("closes a trailing section the scrub emptied and keeps the filled one", () => {
    expect(
      scrubForPublication(
        [
          "## What changed",
          "Added the toggle.",
          "",
          "## Notes",
          "Updated `blazebot/memory/AWP-32.md`.",
        ].join("\n"),
      ),
    ).toBe(
      ["## What changed", "Added the toggle.", "", "## Notes", SCRUB_PLACEHOLDER].join(
        "\n",
      ),
    );
  });

  it("keeps a heading whose section still has content", () => {
    const body = ["## What changed", "Added the toggle."].join("\n");
    expect(scrubForPublication(body)).toBe(body);
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
