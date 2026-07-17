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
