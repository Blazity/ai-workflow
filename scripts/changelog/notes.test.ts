import assert from "node:assert/strict";
import test from "node:test";

import { groupByArea, parseChangelogSection, renderChangelogSection, renderReleaseBody, type ReleaseNotes } from "./notes.ts";

const NOTES: ReleaseNotes = {
  areas: [
    {
      area: "Dashboard",
      bullets: ["The Settings page shows run capacity in one place.", "A ticket page has a Repositories panel."],
      summary: "Settings and tickets are easier to read.",
    },
    {
      area: "MCP",
      bullets: ["MCP tools can read the repository catalog."],
      summary: "Clients can read more without the dashboard.",
    },
  ],
  date: "2026-09-23",
  shortVersion: [
    { area: "Dashboard", text: "Run capacity sits on one page." },
    { area: "MCP", text: "The repository catalog is readable over MCP." },
  ],
  version: "v2026.09.2",
};

test("the CHANGELOG.md section carries the version, the short version, areas and bullets, and no pull request or person", () => {
  const section = renderChangelogSection(NOTES);
  assert.equal(
    section,
    [
      "## v2026.09.2 (2026-09-23)",
      "",
      "**Dashboard:** Run capacity sits on one page.",
      "",
      "**MCP:** The repository catalog is readable over MCP.",
      "",
      "### Dashboard",
      "",
      "_Settings and tickets are easier to read._",
      "",
      "- The Settings page shows run capacity in one place.",
      "- A ticket page has a Repositories panel.",
      "",
      "### MCP",
      "",
      "_Clients can read more without the dashboard._",
      "",
      "- MCP tools can read the repository catalog.",
    ].join("\n"),
  );
  assert.doesNotMatch(section, /#\d|@/u);
});

test("a section reads back into the same release, so the release job needs no second model call", () => {
  assert.deepEqual(parseChangelogSection(renderChangelogSection(NOTES).split("\n")), NOTES);
  const plain = { ...NOTES, shortVersion: [] };
  assert.deepEqual(parseChangelogSection(renderChangelogSection(plain).split("\n")), plain);
  assert.equal(parseChangelogSection(["## 2026-09-21", "", "- An older dated section."]), undefined);
});

test("the release body has Orca's shape: opening, short version, rule, areas with italic summaries and linked bullets", () => {
  const body = renderReleaseBody(NOTES, {
    attributions: new Map([
      ["The Settings page shows run capacity in one place.", { author: "filipmaszota", pullRequest: 424 }],
      ["MCP tools can read the repository catalog.", { pullRequest: 431 }],
    ]),
    previousVersion: "v2026.09.1",
    repository: "Blazity/ai-workflow",
  });

  assert.equal(
    body,
    [
      "What reached AI Workflow users since v2026.09.1, collected on 2026-09-23.",
      "",
      "## The short version",
      "",
      "**Dashboard:** Run capacity sits on one page.",
      "",
      "**MCP:** The repository catalog is readable over MCP.",
      "",
      "---",
      "",
      "### Dashboard",
      "",
      "*Settings and tickets are easier to read.*",
      "",
      "* The Settings page shows run capacity in one place. (in [#424](https://github.com/Blazity/ai-workflow/pull/424) by [@filipmaszota](https://github.com/filipmaszota))",
      // No pull request known for this bullet: it ships as written, unlinked.
      "* A ticket page has a Repositories panel.",
      "",
      "### MCP",
      "",
      "*Clients can read more without the dashboard.*",
      "",
      // Pull request known, author lookup failed: the link stays, the name is left out.
      "* MCP tools can read the repository catalog. (in [#431](https://github.com/Blazity/ai-workflow/pull/431))",
      "",
      "**Full Changelog**: https://github.com/Blazity/ai-workflow/compare/v2026.09.1...v2026.09.2",
      "",
    ].join("\n"),
  );
});

test("without prose from the model the body leaves out the short version but keeps the areas", () => {
  const body = renderReleaseBody(
    { ...NOTES, shortVersion: [] },
    { attributions: new Map(), repository: "Blazity/ai-workflow" },
  );
  assert.doesNotMatch(body, /The short version/u);
  assert.match(body, /^What reached AI Workflow users, collected on 2026-09-23\.\n\n---\n\n### Dashboard/u);
  assert.match(body, /\*\*Full Changelog\*\*: https:\/\/github.com\/Blazity\/ai-workflow\/commits\/v2026\.09\.2\n$/u);
});

test("bullets group by area in the fixed area order, keeping entry order within an area", () => {
  assert.deepEqual(
    groupByArea([
      { area: "Other", text: "o" },
      { area: "MCP", text: "m1" },
      { area: "Dashboard", text: "d" },
      { area: "MCP", text: "m2" },
    ]),
    [
      { area: "Dashboard", bullets: ["d"] },
      { area: "MCP", bullets: ["m1", "m2"] },
      { area: "Other", bullets: ["o"] },
    ],
  );
});
