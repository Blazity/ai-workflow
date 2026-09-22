/**
 * What stage 4 serves: an overview, section headers, and every growable list
 * on its own cursor, each page under the cap, nothing structured cut.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { z } from "zod";
import {
  AGENT_VISIBILITY_PAGE_DEFAULT_BYTES,
  agentBriefingIndexSchema,
  agentBriefingOverview,
  agentBriefingOverviewSchema,
  agentBriefingPartSchema,
  agentBriefingRedactionSpanSchema,
  agentBriefingRepositoryContextSchema,
  agentBriefingRepositorySchema,
  agentBriefingSectionHeader,
  agentBriefingSectionHeaderSchema,
  agentBriefingUnresolvedSourceSchema,
  agentVisibilityListPageSchema,
  assembleClarificationRounds,
  buildAgentBriefing,
  clarificationDeliverySchema,
  clarificationEffectSchema,
  clarificationRoundHeader,
  clarificationRoundHeaderSchema,
  pageList,
  readVisibilityRecord,
} from "./index";

/** The rounds alone; each test that expects skipped rows asserts them. */
const assembleRounds = (rows: Parameters<typeof assembleClarificationRounds>[0]) => {
  const assembly = assembleClarificationRounds(rows);
  assert.deepEqual(assembly.skipped, []);
  return assembly.rounds;
};
import { bytes, fakeSanitizer, prose, stageSixInput } from "./test-support/fixtures";

const jsonBytes = (value: unknown) => bytes(JSON.stringify(value));
const DEFAULT = AGENT_VISIBILITY_PAGE_DEFAULT_BYTES;

/** Walks a list at the default page as stage 4 serves it and stage 5 reads
 *  it: every page under the cap and parsed with the item's schema. */
function walk<S extends z.ZodTypeAny>(items: readonly unknown[], item: S) {
  const seen: z.output<S>[] = [];
  const shortened: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = pageList(items, { cursor });
    assert.ok(jsonBytes(page) <= DEFAULT, `a page is ${jsonBytes(page)} bytes`);
    const read = readVisibilityRecord(agentVisibilityListPageSchema(item), JSON.parse(JSON.stringify(page)));
    const parsed = read.ok ? read.value : assert.fail(read.message);
    seen.push(...parsed.items);
    shortened.push(...parsed.shortened.map((entry) => entry.index));
    cursor = parsed.nextCursor;
    pages += 1;
  } while (cursor !== null);
  return { seen, shortened, pages };
}

/** Six JSON bytes a character: the most any character costs. */
const worst = (length: number) => "\u0001".repeat(length);

// Red when: the overview carries a list that grows with the briefing (section
// headers, unresolved sources, repositories), so a large briefing's overview
// crosses the page and MCP replaces it with a digest.
test("the overview of a maximal index fits the default page", async () => {
  const { index } = await buildAgentBriefing(stageSixInput(), { sanitize: fakeSanitizer() });
  const maximal = JSON.parse(JSON.stringify(index));
  maximal.identity = {
    runId: worst(200),
    nodeId: worst(200),
    attempt: 999_999,
    activationScopeId: worst(200),
    sequence: 10_000,
    kind: `a${"b".repeat(63)}`,
    blockType: worst(200),
    passLabel: worst(200),
    capturedAt: worst(40),
  };
  maximal.harness = {
    provider: `a${"b".repeat(63)}`,
    model: worst(200),
    outputSchema: { sha256: "f".repeat(64) },
    skills: Array.from({ length: 16 }, () => ({ id: worst(100), version: 999_999, sha256: "f".repeat(64) })),
    skillCount: 999_999,
    // A profile id just under the join key bound.
    profile: { pinned: true, id: worst(341), version: 999_999 },
    wrapperScriptSha256: "f".repeat(64),
    includeWorkflowData: false,
    includeRepositoryInstructions: false,
  };
  maximal.unresolvedSources = Array.from({ length: 16 }, () => ({
    kind: `a${"b".repeat(63)}`,
    reference: worst(200),
    message: worst(300),
  }));
  maximal.unresolvedSourceCount = 999_999;
  const read = readVisibilityRecord(agentBriefingIndexSchema, maximal);
  const parsed = read.ok ? read.value : assert.fail(read.message);

  const overview = agentBriefingOverview(parsed);
  assert.ok(jsonBytes(overview) <= DEFAULT, `the overview is ${jsonBytes(overview)} bytes`);
  assert.equal(readVisibilityRecord(agentBriefingOverviewSchema, JSON.parse(JSON.stringify(overview))).ok, true);
  assert.equal("sections" in overview, false);
  assert.equal("unresolvedSources" in overview, false);
});

// Red when: a list drops, repeats or cuts an item, or a page cannot be parsed
// by the schema stage 5 reads it with.
test("every list of a stage 6 briefing pages to completion at the default page", async () => {
  const input = stageSixInput();
  input.unresolvedSources = Array.from({ length: 20 }, (_unused, index) => ({
    kind: "repository",
    reference: `acme/service-${index}:AGENTS.md`,
    message: "The file could not be read.",
  }));
  input.sections[4]!.parts![3]!.content = input.sections[4]!.parts![3]!.content.replace("Filip", "Filip sk-live-SECRET");
  input.sections[4]!.text = input.sections[4]!.parts!.map((part) => part.content).join("");
  const { index, texts } = await buildAgentBriefing(input, { sanitize: fakeSanitizer() });

  const headers = walk(index.sections.map(agentBriefingSectionHeader), agentBriefingSectionHeaderSchema);
  assert.deepEqual(headers.seen, index.sections.map(agentBriefingSectionHeader));
  const runtimeHeader = headers.seen[4]!;
  assert.deepEqual([runtimeHeader.partCount, runtimeHeader.spanCount, runtimeHeader.redactionCount], [125, 1, 1]);

  const runtime = index.sections[4]!;
  const parts = walk(runtime.parts, agentBriefingPartSchema);
  assert.deepEqual(parts.seen, runtime.parts);
  assert.deepEqual(parts.shortened, []);
  assert.deepEqual(walk(runtime.redactions, agentBriefingRedactionSpanSchema).seen, runtime.redactions);
  assert.deepEqual(walk(index.unresolvedSources, agentBriefingUnresolvedSourceSchema).seen, index.unresolvedSources);
  assert.equal(index.unresolvedSourceCount, 20);

  const document = texts.find((entry) => entry.sha256 === index.repositoryContext!.sha256)!.text;
  const context = readVisibilityRecord(agentBriefingRepositoryContextSchema, JSON.parse(document));
  const repositories = context.ok ? context.value.repositories : assert.fail(context.message);
  const walked = walk(repositories, agentBriefingRepositorySchema);
  assert.deepEqual(walked.seen, repositories);
  assert.deepEqual(walked.shortened, []);
  assert.ok(walked.pages > 10, `150 repositories of 5 KB took ${walked.pages} pages`);
});

// Red when: a repository whose description alone is larger than a page stops
// the list (an endless empty page, or an error a client cannot get past), or
// is served without saying it was shortened.
test("a repository larger than a page is served with its long texts shortened and its full size stated", async () => {
  const input = stageSixInput();
  input.repositoryContext!.repositories[1]!.description.text = "ą".repeat(24_000);
  const { index, texts } = await buildAgentBriefing(input, { sanitize: fakeSanitizer() });
  const document = JSON.parse(texts.find((entry) => entry.sha256 === index.repositoryContext!.sha256)!.text);
  const walked = walk(document.repositories, agentBriefingRepositorySchema);
  assert.equal(walked.seen.length, 150);
  assert.deepEqual(walked.shortened, [1]);
  assert.equal(walked.seen[1]!.key, "github:acme/service-1");
  assert.match(walked.seen[1]!.description.text, /\u2026 \(24000 characters in full\)$/);
});

// Red when: a round header carries its deliveries, or a maximal round's
// header or deliveries cannot be served at the default page.
test("round headers, deliveries and effects page to completion, a maximal round included", () => {
  const offered = Array.from({ length: 16 }, (_unused, index) => ({
    key: `github:acme/${"r".repeat(200)}-${index}`,
    askedBecause: "selection",
    named: true,
  }));
  const asks = Array.from({ length: 20 }, (_unused, index) => ({
    clarificationId: `clarification-${String(index).padStart(3, "0")}-${"c".repeat(180)}`,
    runId: `wrun_${"r".repeat(195)}`,
    nodeId: `node_${"n".repeat(195)}`,
    questions: Array.from({ length: 12 }, (_unused2, question) => prose(`question ${question}`, 5_000)),
    askedAt: new Date(Date.UTC(2026, 8, 19, 9, index)).toISOString(),
    status: "cancelled",
    offered,
  }));
  const deliveries = Array.from({ length: 30 }, (_unused, index) => ({
    clarificationId: asks[0]!.clarificationId,
    words: prose(`answer ${index}`, index === 0 ? 25_000 : 300),
    author: { kind: "person", display: prose("name", 300) },
    surface: "jira",
    firstAt: new Date(Date.UTC(2026, 8, 19, 10, index)).toISOString(),
    reading: null,
    note: index === 0 ? prose("note", 5_000) : null,
  }));
  const trail = Array.from({ length: 40 }, (_unused, index) => ({
    id: index + 1,
    at: new Date(Date.UTC(2026, 8, 19, 11, index)).toISOString(),
    event: { kind: "entry_written", clarificationId: asks[0]!.clarificationId, rationale: prose("why", 500) },
  }));
  const rounds = assembleRounds({ questions: asks, deliveries, trail });
  assert.equal(rounds.length, 1);

  const headers = walk(rounds.map(clarificationRoundHeader), clarificationRoundHeaderSchema);
  assert.equal(headers.seen.length, 1);
  const header = headers.seen[0]!;
  assert.deepEqual([header.askCount, header.asks.length, header.deliveryCount, header.effectCount], [20, 16, 30, 40]);

  const walkedDeliveries = walk(rounds[0]!.deliveries, clarificationDeliverySchema);
  assert.equal(walkedDeliveries.seen.length, 30);
  assert.deepEqual(walkedDeliveries.seen.slice(1), rounds[0]!.deliveries.slice(1));
  assert.deepEqual(walk(rounds[0]!.effects, clarificationEffectSchema).seen, rounds[0]!.effects);
});

// Red when: the provenance ceiling or the key bound lets a worst-case section
// header outgrow the default page, or a page that cannot hold a header cuts
// one of its keys to make it fit.
test("a worst-case section header fits the default page and is refused, never cut, by a smaller one", async () => {
  // 341 control characters are 2,046 bytes as JSON: a key just under its bound.
  const key = worst(341);
  const input = stageSixInput();
  input.sections[3] = {
    ...input.sections[3]!,
    kind: `a${"b".repeat(63)}`,
    title: worst(200),
    provenance: Array.from({ length: 40 }, (_unused, index) => ({
      kind: `a${"b".repeat(63)}`,
      id: key,
      version: -2_147_483_648 + index,
      hash: "f".repeat(128),
    })),
  };
  const { index } = await buildAgentBriefing(input, { sanitize: fakeSanitizer() });
  const header = agentBriefingSectionHeader(index.sections[3]!);
  assert.deepEqual([header.provenance.length, header.provenanceCount], [16, 40]);
  assert.ok(header.provenance.every((entry) => entry.id === key));
  assert.ok(jsonBytes(header) <= DEFAULT, `the header is ${jsonBytes(header)} bytes`);
  const page = pageList([header]);
  assert.deepEqual([page.items[0], page.shortened], [header, []]);

  // Cut to 64 characters each, its keys would fit 16 KB; whole, they do not.
  assert.throws(
    () => pageList([header], { maxBytes: 16_384 }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "item_too_large" && "fullBytes" in error && error.fullBytes === jsonBytes(header),
  );
});
