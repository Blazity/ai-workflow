import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REDACTION_REPLACEMENT,
  buildAgentBriefing,
  byteRangeInPage,
  pageSectionText,
  type AgentBriefingBuildInput,
  type AgentBriefingIndex,
  type AgentBriefingSectionPage,
} from "@shared/agent-visibility";

import { locateOnPage, readSection, type ScanCount, type TextPiece } from "./section-text";
import { SECRET, fixtureSanitizer } from "./test-support/fixtures";

const SMALL_PAGE = 1_024;

function input(parts: { id: string; content: string; kind?: string }[]): AgentBriefingBuildInput {
  return {
    identity: {
      runId: "wrun_t",
      nodeId: "planning",
      attempt: 1,
      activationScopeId: "root",
      sequence: 1,
      kind: "agent",
      blockType: "planning_agent",
      capturedAt: "2026-09-19T10:00:00.000Z",
    },
    harness: { provider: "claude", model: "claude-opus-4-1", profile: null, wrapperScript: null },
    sections: [
      {
        kind: "runtime",
        title: "Runtime data",
        text: parts.map((part) => part.content).join(""),
        parts: parts.map((part) => ({
          id: part.id,
          title: part.id,
          origin: { kind: part.kind ?? "ticket" },
          content: part.content,
        })),
      },
    ],
  };
}

async function served(parts: { id: string; content: string; kind?: string }[], maxBytes = SMALL_PAGE) {
  const built = await buildAgentBriefing(input(parts), { sanitize: fixtureSanitizer });
  const section = built.index.sections[0]!;
  const text = built.texts.find((entry) => entry.sha256 === section.storedSha256)!.text;
  const pages: AgentBriefingSectionPage[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    // Through JSON, as a page reaches the browser.
    const page = JSON.parse(JSON.stringify(pageSectionText({ sectionIndex: 0, text, offset, maxBytes }))) as AgentBriefingSectionPage;
    pages.push(page);
    offset = page.nextOffset;
  }
  return { section, pages, text, index: built.index as AgentBriefingIndex };
}

const joined = (pieces: readonly TextPiece[]) => pieces.map((piece) => ("text" in piece ? piece.text : "")).join("");

test("every part and redaction lands where the package's own byteRangeInPage puts it, on every page", async () => {
  // Polish letters, emoji and secrets, so bytes and string indices diverge.
  const parts = Array.from({ length: 60 }, (_unused, index) => ({
    id: `comment:${index + 1}`,
    content: `Komentarz ${index + 1}: zażółć gęślą jaźń 📱🧾 ${index % 7 === 0 ? `klucz ${SECRET} ` : ""}anna${index}@acme.dev\n`,
  }));
  const { section, pages } = await served(parts);
  assert.ok(pages.length > 3, "the section spans several pages");
  for (const page of pages) {
    assert.deepEqual(
      locateOnPage(page, section.parts.map((part) => part.range)),
      section.parts.map((part) => byteRangeInPage(page, part.range)),
    );
    assert.deepEqual(locateOnPage(page, section.redactions), section.redactions.map((span) => byteRangeInPage(page, span)));
  }
});

test("the text of every part, read across pages, is the stored text of that part and nothing else", async () => {
  const parts = [
    { id: "platform:rule", content: "Repository access protocol: request by key.\n\n", kind: "platform" },
    { id: "ticket", content: `${"Koszyk nie działa na telefonie 📱. ".repeat(80)}\n` },
    { id: "comment:1", content: `Filip: klucz ${SECRET}, proszę nie używać.\n` },
  ];
  const { section, pages, text } = await served(parts);
  const reading = readSection(pages, section.parts, section.redactions);
  assert.equal(reading.unattributed, null);
  assert.equal(reading.loadedBytes, Buffer.byteLength(text, "utf8"));
  assert.equal(reading.parts.map((part) => joined(part.pieces)).join(""), text);
  const comment = reading.parts.find((part) => part.part.id === "comment:1")!;
  assert.equal(joined(comment.pieces), `Filip: klucz ${DEFAULT_REDACTION_REPLACEMENT}, proszę nie używać.\n`);
  assert.deepEqual(
    comment.pieces.filter((piece) => piece.kind === "redacted").map((piece) => ("text" in piece ? piece.text : "")),
    [DEFAULT_REDACTION_REPLACEMENT],
  );
});

/** Finds the filler length that puts the page boundary where `wanted` says. */
async function boundaryCase(wanted: (boundary: number, emojiEnd: number, spanStart: number, spanEnd: number) => boolean) {
  for (let filler = 850; filler < 1_100; filler += 1) {
    const content = `${"a".repeat(filler)}📱${SECRET} po sekrecie.\n`;
    const result = await served([{ id: "ticket", content }]);
    const boundary = result.pages[0]!.nextOffset!;
    const emojiEnd = Buffer.byteLength(`${"a".repeat(filler)}📱`, "utf8");
    const span = result.section.redactions[0]!;
    if (wanted(boundary, emojiEnd, span.start, span.end)) return result;
  }
  throw new Error("no filler length puts the boundary there");
}

test("an emoji ending one page does not shift the redaction that opens the next", async () => {
  const { section, pages } = await boundaryCase((boundary, emojiEnd) => boundary === emojiEnd);
  const [first, second] = pages;
  assert.ok(first!.text.endsWith("📱"), "the first page ends with the emoji, whole");
  const reading = readSection(pages, section.parts, section.redactions);
  const pieces = reading.parts[0]!.pieces;
  const marker = pieces.findIndex((piece) => piece.kind === "redacted");
  assert.equal(joined(pieces.slice(0, marker)), first!.text);
  assert.equal("text" in pieces[marker]! ? pieces[marker]!.text : null, DEFAULT_REDACTION_REPLACEMENT);
  assert.ok(second!.text.startsWith(DEFAULT_REDACTION_REPLACEMENT));
});

test("a redaction straddling a page boundary right after an emoji is marked on both pages, whole", async () => {
  const { section, pages } = await boundaryCase(
    (boundary, emojiEnd, spanStart, spanEnd) => spanStart === emojiEnd && spanStart < boundary && boundary < spanEnd,
  );
  const reading = readSection(pages, section.parts, section.redactions);
  const redacted = reading.parts[0]!.pieces.filter((piece) => piece.kind === "redacted");
  assert.equal(redacted.length, 2, "one piece on each page");
  assert.equal(redacted.map((piece) => ("text" in piece ? piece.text : "")).join(""), DEFAULT_REDACTION_REPLACEMENT);
  const before = reading.parts[0]!.pieces[reading.parts[0]!.pieces.indexOf(redacted[0]!) - 1]!;
  assert.ok("text" in before && before.text.endsWith("📱"));
});

test("text whose part entries have not loaded yet is kept apart, never folded into the last loaded part", async () => {
  const parts = [
    { id: "ticket", content: "Ticket AWP-235.\n" },
    { id: "comment:1", content: "Filip: after the deploy.\n" },
    { id: "comment:2", content: "Anna: iOS only.\n" },
  ];
  const { section, pages } = await served(parts);
  const reading = readSection(pages, section.parts.slice(0, 1), section.redactions);
  assert.equal(joined(reading.parts[0]!.pieces), "Ticket AWP-235.\n");
  assert.equal(joined(reading.unattributed ?? []), "Filip: after the deploy.\nAnna: iOS only.\n");
});

test("with only the first page loaded, a part crossing into the second reads as partly loaded and later parts as not loaded", async () => {
  const parts = [
    { id: "ticket", content: `${"x".repeat(700)}\n` },
    { id: "log", content: `${"y".repeat(900)}\n` },
    { id: "comment:1", content: "Anna: iOS only.\n" },
  ];
  const { section, pages } = await served(parts);
  const reading = readSection(pages.slice(0, 1), section.parts, section.redactions);
  assert.deepEqual(
    reading.parts.map((part) => part.loaded),
    ["all", "some", "none"],
  );
});

test("800 parts and 2,000 redactions on one page are placed without walking the page once per range", async () => {
  const secretLine = (index: number) => `${index}: ${SECRET} x${SECRET} y${SECRET} ó\n`;
  const parts = Array.from({ length: 800 }, (_unused, index) => ({
    id: `line:${index + 1}`,
    content: index < 667 ? secretLine(index) : `${index}: zażółć\n`,
  }));
  const { section, pages } = await served(parts, 524_288);
  assert.equal(pages.length, 1);
  assert.ok(section.redactions.length >= 2_000, `${section.redactions.length} redactions`);
  const ranges = section.parts.length + section.redactions.length;
  const scans: ScanCount = { units: 0 };
  const reading = readSection(pages, section.parts, section.redactions, scans);
  assert.equal(reading.parts.length, 800);
  // What this guards is the work, not the clock: a threshold in milliseconds
  // measures the machine, and this same reading takes 5 ms idle and over two
  // seconds on a loaded laptop. The page is handed to `byteRangeInPage` in
  // windows, so the two range lists cost one walk of the page each, whatever
  // they hold. Handing it the whole page per range instead costs one walk per
  // range: ~2,800 walks of a 500 KB page, which is what froze a phone.
  const walks = scans.units / pages[0]!.text.length;
  assert.ok(walks < 4, `${walks.toFixed(1)} walks of the page to place ${ranges} ranges`);
});
