/**
 * The package used the way its three consumers will use it: the worker's
 * capture adapter (stage 3b) mapping sends to input, the read model (stage 4)
 * storing texts once and paging them under a cap, and the dashboard (stage 5)
 * parsing what is served and placing part ranges and redactions on pages.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { z } from "zod";
import {
  AGENT_BRIEFING_ORIGIN_KINDS,
  agentBriefingIndexSchema,
  agentBriefingOverview,
  agentBriefingOverviewSchema,
  agentBriefingPartSchema,
  agentBriefingRedactionSpanSchema,
  agentBriefingRepositoryContextSchema,
  agentBriefingRepositorySchema,
  agentBriefingSectionHeader,
  agentBriefingSectionHeaderSchema,
  agentBriefingSectionPageSchema,
  agentVisibilityListPageSchema,
  buildAgentBriefing,
  byteRangeInPage,
  explainMissingBriefing,
  isKnownSlug,
  pageList,
  pageSectionText,
  readVisibilityRecord,
  type AgentBriefingBuildInput,
  type AgentBriefingIndex,
  type AgentBriefingSectionPage,
} from "./index";
import { fakeSanitizer, sha } from "./test-support/fixtures";

// Shaped like EffectivePromptCompilation (packages/prompts/effective-prompt.ts)
// with the runtime parts stage 2 adds. Written by hand; nothing imports the
// compiler, exactly as the adapter will not make this package import it.
interface CompiledPart {
  id: string;
  title: string;
  origin: { kind: string; ref?: string; label?: string };
  content: string;
}
interface CompiledSection {
  kind: "profile" | "repository" | "memory" | "block" | "runtime";
  title: string;
  content: string;
  hash: string;
  provenance: { kind: string; id: string; version: number | null; hash: string }[];
  parts?: CompiledPart[];
}
interface Compilation {
  prompt: string;
  sections: CompiledSection[];
  unresolvedSources: { kind: string; reference: string; message: string }[];
}

const TICKET = "AWP-240: Koszyk nie działa na telefonie 📱. Klucz testowy: sk-live-SECRET, proszę nie używać.\n\n";
const RULE = "Repository access protocol: request a repository by its key.\n\n";
/** Enough ticket text to cross several 1 KB pages. */
const REPEAT = 40;

function compilation(extraNote: string | null): Compilation {
  const parts: CompiledPart[] = [
    { id: "platform:repository_access", title: "Repository access protocol", origin: { kind: "platform" }, content: RULE },
    { id: "ticket", title: "Ticket AWP-240", origin: { kind: "ticket", ref: "AWP-240" }, content: TICKET.repeat(REPEAT) },
  ];
  if (extraNote) {
    parts.push({ id: "work_scope_note", title: "Refused request", origin: { kind: "work_scope_note" }, content: extraNote });
  }
  const runtime = parts.map((part) => part.content).join("");
  const section = (kind: CompiledSection["kind"], title: string, content: string, parts?: CompiledPart[]): CompiledSection => ({
    kind,
    title,
    content,
    hash: sha(content),
    provenance: [{ kind: kind === "block" ? "prompt" : kind, id: `${kind}:source`, version: 1, hash: sha(content) }],
    ...(parts ? { parts } : {}),
  });
  const sections = [
    section("profile", "Harness profile", "Odpowiadaj precyzyjnie."),
    section("block", "Block role and task", "Plan the change."),
    section("runtime", "Runtime data", runtime, parts),
  ];
  return { prompt: "(rendered with sentinels)", sections, unresolvedSources: [] };
}

/** The adapter stage 3b writes: one counter per attempt, shared by every kind. */
function agentSend(sequence: number, passLabel: string | undefined, compiled: Compilation): AgentBriefingBuildInput {
  return {
    identity: {
      runId: "wrun_AWP240",
      nodeId: "planning",
      attempt: 1,
      activationScopeId: "root",
      sequence,
      kind: "agent",
      blockType: "planning_agent",
      ...(passLabel ? { passLabel } : {}),
      capturedAt: `2026-09-19T10:0${sequence}:00.000Z`,
    },
    harness: {
      provider: "claude",
      model: "claude-opus-4-1",
      outputSchema: '{"type":"object"}',
      skills: [],
      profile: { id: "builtin-claude", version: 7 },
      wrapperScript: "#!/bin/sh\nclaude --print\n",
    },
    sections: compiled.sections.map((entry) => ({
      kind: entry.kind,
      title: entry.title,
      provenance: entry.provenance,
      text: entry.content,
      ...(entry.parts ? { parts: entry.parts } : {}),
    })),
    repositoryContext: {
      repositories: [
        {
          key: "github:acme/shop-web",
          description: { source: "catalog", text: "Sklep: frontend." },
          rules: null,
          relationships: [{ kind: "frontend_for", target: "github:acme/shop-api" }],
          state: "write",
          inclusion: { cause: "named" },
          rendering: "full",
          workScopeEntry: null,
        },
        {
          key: "github:acme/shop-api",
          description: { source: "catalog", text: "Sklep: API." },
          rules: null,
          relationships: [],
          state: "read_only",
          inclusion: { cause: "related", via: { key: "github:acme/shop-web", relationship: "frontend_for" } },
          rendering: "full",
          workScopeEntry: null,
        },
      ],
      unlistedCount: 0,
      workScope: { version: 1, leftOutKeys: [] },
      renderedAt: { sectionIndex: 2, partId: "platform:repository_access" },
    },
    unresolvedSources: compiled.unresolvedSources,
  };
}

function discoverySend(): AgentBriefingBuildInput {
  const listing = "github:acme/shop-web: Storefront\ngithub:acme/shop-api: API\n";
  const instruction = "Choose the repositories this ticket needs.\n";
  return {
    identity: {
      runId: "wrun_AWP240",
      nodeId: "planning",
      attempt: 1,
      activationScopeId: "root",
      sequence: 1,
      kind: "discovery",
      blockType: "planning_agent",
      capturedAt: "2026-09-19T10:00:00.000Z",
    },
    harness: { provider: "claude", model: "claude-opus-4-1", outputSchema: '{"type":"object"}', profile: null, wrapperScript: "#!/bin/sh\nclaude\n" },
    sections: [
      {
        kind: "discovery",
        title: "Repository discovery",
        text: `${instruction}${listing}`,
        parts: [
          { id: "platform:discovery_instructions", title: "Instructions", origin: { kind: "platform" }, content: instruction },
          { id: "catalog_listing", title: "Catalog", origin: { kind: "repository_catalog" }, content: listing },
        ],
      },
    ],
    repositoryContext: {
      repositories: ["shop-web", "shop-api"].map((name) => ({
        key: `github:acme/${name}`,
        description: { source: "provider", text: name },
        rules: null,
        relationships: [],
        state: "offered",
        inclusion: { cause: "catalog" },
        rendering: "line",
        workScopeEntry: null,
      })),
      unlistedCount: 0,
      workScope: null,
    },
  };
}

function llmSend(): AgentBriefingBuildInput {
  return {
    identity: {
      runId: "wrun_AWP240",
      nodeId: "summarize",
      attempt: 1,
      activationScopeId: "root",
      sequence: 1,
      kind: "llm",
      blockType: "call_llm",
      capturedAt: "2026-09-19T10:20:00.000Z",
    },
    harness: { provider: "claude", model: "claude-haiku-4-5", outputSchema: null, profile: null, wrapperScript: null },
    sections: [
      { kind: "system", title: "System prompt", text: "You summarize tickets." },
      { kind: "block", title: "Prompt", text: "Summarize AWP-240." },
    ],
    repositoryContext: null,
  };
}

/** The read model's store: indexes by identity, texts once by sha256. */
class Store {
  readonly texts = new Map<string, string>();
  readonly indexes: AgentBriefingIndex[] = [];
  async record(input: AgentBriefingBuildInput) {
    const built = await buildAgentBriefing(input, { sanitize: fakeSanitizer() });
    for (const entry of built.texts) if (!this.texts.has(entry.sha256)) this.texts.set(entry.sha256, entry.text);
    this.indexes.push(JSON.parse(JSON.stringify(built.index)));
    return built.index;
  }
}

/** Stage 4 serves a list page by page; stage 5 parses each page with the
 *  item's schema. Returns every item in order. */
function readWholeList<S extends z.ZodTypeAny>(items: readonly unknown[], item: S, maxBytes: number): z.output<S>[] {
  const seen: z.output<S>[] = [];
  let cursor: string | null = null;
  do {
    const served: unknown = JSON.parse(JSON.stringify(pageList(items, { cursor, maxBytes })));
    const read = readVisibilityRecord(agentVisibilityListPageSchema(item), served);
    const page = read.ok ? read.value : assert.fail(read.message);
    assert.deepEqual(page.shortened, []);
    seen.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return seen;
}

function readAllPages(text: string, sectionIndex: number, maxBytes: number): AgentBriefingSectionPage[] {
  const pages: AgentBriefingSectionPage[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const served: unknown = JSON.parse(JSON.stringify(pageSectionText({ sectionIndex, text, offset, maxBytes })));
    const read = readVisibilityRecord(agentBriefingSectionPageSchema, served);
    assert.equal(read.ok, true);
    const page = read.ok ? read.value : assert.fail();
    pages.push(page);
    offset = page.nextOffset;
  }
  return pages;
}

test("a planning attempt that discovers and plans twice, and a call_llm send, as the three consumers use them", async () => {
  const store = new Store();
  // Stage 3b: discovery first, then two passes, one counter.
  await store.record(discoverySend());
  await store.record(agentSend(2, undefined, compilation(null)));
  const secondPass = await store.record(
    agentSend(3, "expansion closed", compilation("github:acme/legacy was refused: excluded by a person.\n")),
  );
  await store.record(llmSend());

  assert.deepEqual(
    store.indexes.filter((index) => index.identity.nodeId === "planning").map((index) => [index.identity.sequence, index.identity.kind]),
    [
      [1, "discovery"],
      [2, "agent"],
      [3, "agent"],
    ],
  );
  // The profile and block text of both passes is stored once, and so is the
  // map both passes saw: discovery's context, one section, three sections
  // and one context for the first pass, one new runtime section for the
  // second, two sections for call_llm.
  assert.equal(store.indexes[1]!.sections[0]!.storedSha256, store.indexes[2]!.sections[0]!.storedSha256);
  assert.equal(store.indexes[1]!.repositoryContext!.sha256, store.indexes[2]!.repositoryContext!.sha256);
  assert.equal(store.texts.size, 1 + 1 + 3 + 1 + 1 + 2);
  assert.equal(store.indexes[0]!.harness.profile.pinned, false);
  assert.equal(store.indexes[3]!.harness.wrapperScriptSha256, null);
  assert.equal(store.indexes[3]!.repositoryContext, null);

  // Stage 4 serves each briefing as an overview and a list of section
  // headers; stage 5 parses both. An origin kind this build has no label for
  // is shown as itself.
  for (const index of store.indexes) {
    assert.equal(readVisibilityRecord(agentBriefingIndexSchema, index).ok, true);
    const overview = readVisibilityRecord(agentBriefingOverviewSchema, JSON.parse(JSON.stringify(agentBriefingOverview(index))));
    assert.equal(overview.ok, true);
    const headers = readWholeList(index.sections.map(agentBriefingSectionHeader), agentBriefingSectionHeaderSchema, 1_024);
    assert.equal(headers.length, index.totals.sections);
  }
  const origins = secondPass.sections[2]!.parts.map((part) =>
    isKnownSlug(AGENT_BRIEFING_ORIGIN_KINDS, part.origin.kind) ? `label:${part.origin.kind}` : part.origin.kind,
  );
  assert.deepEqual(origins, ["label:platform", "ticket", "work_scope_note"]);

  // Stage 4 pages the runtime section under a small cap; stage 5 puts the
  // ticket part and its redactions back together from the pages.
  const runtime = secondPass.sections[2]!;
  const stored = store.texts.get(runtime.storedSha256)!;
  const pages = readAllPages(stored, runtime.index, 1_024);
  assert.ok(pages.length > 3);
  assert.equal(pages.map((page) => page.text).join(""), stored);

  const ticket = runtime.parts.find((part) => part.id === "ticket")!;
  const ticketText = pages
    .map((page) => {
      const at = byteRangeInPage(page, ticket.range);
      return at ? page.text.slice(at.start, at.end) : "";
    })
    .join("");
  assert.equal(ticketText, TICKET.replace("sk-live-SECRET", "[REDACTED]").repeat(REPEAT));
  // The parts and the spans reach stage 5 as lists of their own.
  assert.deepEqual(readWholeList(runtime.parts, agentBriefingPartSchema, 1_024), runtime.parts);
  const spans = readWholeList(runtime.redactions, agentBriefingRedactionSpanSchema, 1_024);
  assert.equal(spans.length, REPEAT);
  for (const span of spans) {
    const marked = pages
      .map((page) => {
        const at = byteRangeInPage(page, span);
        return at ? page.text.slice(at.start, at.end) : "";
      })
      .join("");
    assert.equal(marked, "[REDACTED]");
  }

  // Stage 4 reads the context document by its reference and pages its
  // repositories; stage 5 reads them back.
  const document = readVisibilityRecord(
    agentBriefingRepositoryContextSchema,
    JSON.parse(store.texts.get(secondPass.repositoryContext!.sha256)!),
  );
  const context = document.ok ? document.value : assert.fail(document.message);
  assert.deepEqual(readWholeList(context.repositories, agentBriefingRepositorySchema, 1_024), context.repositories);

  // A third planning pass that failed before sending is explained, and the
  // briefings this attempt did capture do not hide it.
  assert.equal(
    explainMissingBriefing({
      attemptState: "failed",
      runStatus: "failed",
      failure: { category: "sandbox", message: "The sandbox stopped responding." },
      promptSent: "unknown",
      captureCapable: true,
      captureDisabled: false,
      capturedKinds: ["discovery", "agent", "agent"],
      replayExpired: false,
      sendsEveryAttempt: true,
      runLostASend: false,
    }).kind,
    "never_sent",
  );
});
