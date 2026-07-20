import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSections } from "./sections.ts";

test("a body without headings is one Introduction section", () => {
  const body = "just some prose\nwith two lines";
  assert.deepEqual(splitSections(body), [
    { title: "Introduction", level: 0, start: 0, end: body.length, body },
  ]);
});

test("leading text before the first heading becomes Introduction", () => {
  const body = "intro line\n## First\nbody\n## Second\nmore";
  const sections = splitSections(body);
  assert.deepEqual(
    sections.map((s) => ({ title: s.title, level: s.level })),
    [
      { title: "Introduction", level: 0 },
      { title: "First", level: 2 },
      { title: "Second", level: 2 },
    ],
  );
  assert.equal(sections[0].body, "intro line\n");
});

test("no Introduction when the body starts with a heading", () => {
  const sections = splitSections("# Top\ncontent");
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, "Top");
  assert.equal(sections[0].level, 1);
});

test("captures nested heading levels", () => {
  const body = "# H1\na\n## H2\nb\n### H3\nc";
  assert.deepEqual(
    splitSections(body).map((s) => ({ title: s.title, level: s.level })),
    [
      { title: "H1", level: 1 },
      { title: "H2", level: 2 },
      { title: "H3", level: 3 },
    ],
  );
});

test("each heading section spans up to the next heading", () => {
  const sections = splitSections("# One\nalpha\n# Two\nbeta");
  assert.equal(sections[0].body, "# One\nalpha\n");
  assert.equal(sections[1].body, "# Two\nbeta");
});

test("a selected section body contains only that heading and its content", () => {
  const body = "# First\nalpha\n\n## Second\nbeta\n\n# Third\ngamma";
  const sections = splitSections(body);
  assert.equal(sections[1].title, "Second");
  assert.equal(sections[1].body, "## Second\nbeta\n\n");
  assert.equal(sections[1].body.includes("# Third"), false);
});

test("concatenating section bodies reconstructs the original", () => {
  const bodies = [
    "no headings here at all",
    "lead\n# A\nx\n## B\ny\n### C\nz",
    "# StartsWithHeading\ntail",
    "",
    "trailing newline after heading\n# H\n",
  ];
  for (const body of bodies) {
    const joined = splitSections(body)
      .map((s) => s.body)
      .join("");
    assert.equal(joined, body);
  }
});

test("an empty body reconstructs to an empty Introduction", () => {
  assert.deepEqual(splitSections(""), [
    { title: "Introduction", level: 0, start: 0, end: 0, body: "" },
  ]);
});

test("a heading inside a fenced code block does not split", () => {
  const body = "# Real\nlead\n```markdown\n# Session Memory\nnotes\n```\ntail";
  const sections = splitSections(body);
  assert.deepEqual(
    sections.map((s) => ({ title: s.title, level: s.level })),
    [{ title: "Real", level: 1 }],
  );
});

test("fences that close and reopen only gate their own interiors", () => {
  const body = "# A\n```\n# hidden\n```\n# B\n~~~\n## also hidden\n~~~\n# C";
  assert.deepEqual(
    splitSections(body).map((s) => s.title),
    ["A", "B", "C"],
  );
});

test("a ~~~ line inside a ``` fence does not close it", () => {
  const body = "```\n~~~\n# still fenced\n```\n# Real";
  assert.deepEqual(
    splitSections(body).map((s) => ({ title: s.title, level: s.level })),
    [
      { title: "Introduction", level: 0 },
      { title: "Real", level: 1 },
    ],
  );
});

test("real headings outside fences still split with correct levels", () => {
  const body = "# H1\na\n```\n### fake\n```\n## H2\nb";
  assert.deepEqual(
    splitSections(body).map((s) => ({ title: s.title, level: s.level })),
    [
      { title: "H1", level: 1 },
      { title: "H2", level: 2 },
    ],
  );
});

test("reconstruction is exact for bodies containing fenced code blocks", () => {
  const bodies = [
    "# Real\nlead\n```markdown\n# Session Memory\nnotes\n```\nafter",
    "```\n# only in fence\n```",
    "intro\n~~~python\n# comment\n~~~\n# Heading\nbody",
    "```\n~~~\n# still fenced\n```\n# Real\ntail\n",
  ];
  for (const body of bodies) {
    const joined = splitSections(body)
      .map((s) => s.body)
      .join("");
    assert.equal(joined, body);
  }
});
