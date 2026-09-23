/**
 * What a send records, proved on the REAL compiler output.
 *
 * The visibility builder refuses a section whose parts do not reproduce its
 * text exactly, and that refusal is quiet: it stores a marker and the run goes
 * on. So a single separator this adapter got wrong would turn every briefing
 * in production into an empty marker with nothing red anywhere. Hand-built
 * sections would prove nothing about that, which is why every send kind below
 * goes through the composer and the compiler the run really uses, on the
 * production-shaped matrix (Polish text and an emoji, the compiler's own
 * sentinels, a NUL), and the assertion is the OUTCOME: `recorded`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// A deployment with nothing connected: the secrets it knows are its
// environment's. This suite is about something else, and the real source reads
// the integration settings from a database it does not have
// (services/integrations/secret-values.test.ts proves that read).
vi.mock("../../services/integrations/secret-values.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/integrations/secret-values.js")>();
  const { environmentSecretValues } = await import("../../run-observability/configured-secrets.js");
  return { ...actual, knownSecretValues: async () => environmentSecretValues() };
});
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import {
  listAgentBriefingRowsOfRun,
  readAgentBriefingRecord,
  readAgentBriefingRunSummary,
} from "../../db/repositories/agent-visibility.js";
import { logger } from "../../infra/logger.js";
import { compileEffectivePrompt } from "../helpers/effective-prompt.js";
import type { EffectivePromptCompilation, EffectivePromptRepositorySource } from "@shared/prompts";
import {
  fixContextParts,
  implementationContextParts,
  researchPlanContextParts,
  reviewContextParts,
} from "../../sandbox/context.js";
import { genericAgentRuntimeData } from "../blocks/generic-agent/execute.js";
import { composeRepositoryDiscoveryPrompt } from "../repository-discovery/runner.js";
import {
  discoveryRows,
  fixRows,
  genericRows,
  implementationRows,
  researchRows,
  reviewRows,
} from "../../test-support/prompt-oracle/matrix.js";
import { agentBriefingIndexSchema, shortenVisibilityId, type AgentBriefingIndex } from "@shared/agent-visibility";
import { captureAgentBriefing, captureSkippedSend } from "./capture.js";
import {
  createBriefingSequence,
  nextBriefingIdentity,
  planCompiledBriefing,
  planPartsBriefing,
  planTextBriefing,
  BRIEFING_CAPTURE_MAX_BYTES,
  planDeferredBriefing,
  type BriefingIdentity,
} from "./plan.js";
import { discoveryRepositoryContext, selectedRepositoryContext } from "./repository-context.js";

const RUN = "wrun_briefing";
const HARNESS = { provider: "claude", model: "claude-sonnet-4-5-20250929" } as const;

// The matrix tests compile some fifty production-shaped prompts and store a
// briefing for each, hashing hundreds of kilobytes on the way. That is a few
// seconds on an idle machine and a minute on a busy one, and a test killed
// half way keeps writing rows into the database the next one just reset, so
// one timeout cascades into several false failures. The generous bound is
// about the machine, not about what is proved here.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let db: Db;

beforeEach(async () => {
  vi.restoreAllMocks();
  db = await createTestDb();
});


/** The stored index as the contract reads it, which is how stage 4 will. */
function indexOf(record: { briefing: { index: unknown } } | null): AgentBriefingIndex {
  return agentBriefingIndexSchema.parse(record?.briefing.index);
}

function identity(overrides: Partial<BriefingIdentity> = {}): BriefingIdentity {
  return {
    enabled: true,
    runId: RUN,
    nodeId: "planning",
    blockType: "planning_agent",
    attempt: 1,
    activationScopeId: "root",
    sequence: 1,
    ...overrides,
  };
}

async function compile(
  runtimeData: ReturnType<typeof researchPlanContextParts>,
  extras: {
    blockPrompt?: string;
    repositorySources?: EffectivePromptRepositorySource[];
    includeWorkflowData?: boolean;
  } = {},
): Promise<EffectivePromptCompilation> {
  return compileEffectivePrompt({
    nodeId: "planning",
    blockPrompt: extras.blockPrompt ?? "Plan the change and write it down.",
    runtimeData,
    profileContext: {
      includeWorkflowData: extras.includeWorkflowData ?? true,
      includeRepositoryInstructions: true,
    },
    profileSource: {
      profileId: "claude-default",
      version: 3,
      name: "Claude default",
      instructions: "Work in the checkout. Zażółć gęślą jaźń 🚀",
    },
    ...(extras.repositorySources ? { repositorySources: extras.repositorySources } : {}),
  });
}

/** The whole production path of one compiled send: compile, plan, record. */
async function record(
  compilation: EffectivePromptCompilation,
  sequence: number,
  overrides: Partial<BriefingIdentity> = {},
) {
  const capture = planCompiledBriefing({
    ...identity({ sequence, ...overrides }),
    kind: "agent",
    prompt: compilation.prompt,
    compilation,
    harness: { ...HARNESS, profile: { id: "claude-default", version: 3 } },
  });
  // Every compiled section is on the record with exactly its own parts. The
  // outcome alone would not say so: a prompt this adapter cannot take apart is
  // deliberately recorded whole and unattributed, which still records. So one
  // separator read wrongly would keep every briefing green while quietly
  // losing the answer to "where did this paragraph come from".
  // The leading sections are the compiled ones, in order; anything after them
  // is what the compiler did not render and the record adds back.
  expect(
    capture?.sections
      .slice(0, compilation.sections.length)
      .map((section) => section.parts?.length ?? 0),
  ).toEqual(compilation.sections.map((section) => section.parts.length));
  return captureAgentBriefing(capture, { prompt: compilation.prompt }, { db });
}

const recorded = { outcome: "recorded", briefingId: expect.any(Number) };

describe("a briefing built from the real compiler output", () => {
  // Red when: the adapter's idea of where a section sits, or of how its parts
  // tile it, differs from the compiler's by one character. Every kind, because
  // each composer builds its parts differently and one of them being wrong is
  // invisible from any other.
  it.each([
    ["research", () => researchRows(), researchPlanContextParts],
    ["implementation", () => implementationRows(), implementationContextParts],
    ["review", () => reviewRows(), reviewContextParts],
    ["fix agent", () => fixRows(), fixContextParts],
  ] as const)("records every %s send of the production matrix", async (_name, rows, parts) => {
    let sent = 0;
    for (const row of rows()) {
      let runtimeData;
      try {
        runtimeData = parts({ ...(row.input as unknown as Record<string, unknown>), prompt: "" } as never);
      } catch {
        // The composer refuses this input, so no send happens at all.
        continue;
      }
      sent += 1;
      const compilation = await compile(runtimeData);
      expect(await record(compilation, sent), row.name).toEqual(recorded);
    }
    expect(sent).toBeGreaterThan(5);
    expect(await listAgentBriefingRowsOfRun(db, RUN)).toHaveLength(sent);
  });

  // Red when: generic_agent's runtime parts (bound inputs and a clarification
  // answer) stop tiling their section, which the other composers would not
  // catch because it builds its parts from arbitrary JSON.
  it("records every generic agent send of the production matrix", async () => {
    let sent = 0;
    for (const row of genericRows()) {
      const runtimeData = genericAgentRuntimeData(
        row.input.resolvedInputs,
        row.input.clarificationAnswer,
      );
      const compilation = await compile(runtimeData, { blockPrompt: "Do the thing." });
      sent += 1;
      expect(await record(compilation, sent), row.name).toEqual(recorded);
    }
    expect(sent).toBeGreaterThan(5);
  });

  // Red when: discovery's own parts stop tiling its prompt. Discovery has no
  // compiler at all, so nothing else here exercises that path.
  it("records every discovery send of the production matrix", async () => {
    let sent = 0;
    for (const row of discoveryRows()) {
      const composed = composeRepositoryDiscoveryPrompt(row.input as never);
      sent += 1;
      const capture = planPartsBriefing({
        ...identity({ sequence: sent, nodeId: "prepare", blockType: "prepare_workspace" }),
        kind: "discovery",
        sectionKind: "discovery",
        sectionTitle: "Repository discovery",
        prompt: composed.prompt,
        parts: composed.parts,
        harness: { ...HARNESS, profile: null },
      });
      // The same check the compiled sends make: discovery is the one send kind
      // with no compiler behind it, so a change to its composer would
      // otherwise leave this green while every part lost its origin.
      expect(capture?.sections[0]?.parts?.length, row.name).toBe(composed.parts.length);
      expect(
        await captureAgentBriefing(capture, { prompt: composed.prompt }, { db }),
        row.name,
      ).toEqual(recorded);
    }
    expect(sent).toBeGreaterThan(5);
  });

  // Red when: the shapes a person actually meets in production break the
  // builder's bounds: a quarter-megabyte ticket that the compiler cuts, a CI
  // log whose CRLF and control characters have to be normalized, an AGENTS.md
  // section with its own provenance, and a catalog far past the storage
  // budget. Every one of these would fail as a quiet marker.
  it("records the extreme shapes a production run really carries", async () => {
    const ciLog = `Running checks\r\n\u001B[31mFAIL\u001B[0m src/a.test.ts\r\n  expected 1\r\n`.repeat(200);
    const agents = "# AGENTS.md\n\nRun `pnpm test` before you push. Zażółć gęślą jaźń.\n".repeat(50);
    const runtimeData = researchPlanContextParts({
      ticket: {
        identifier: "AIW-7",
        title: "Zażółć gęślą jaźń 🚀",
        description: "x".repeat(250_000),
        acceptanceCriteria: ciLog,
        comments: [
          {
            id: "c1",
            author: "ada",
            body: "The compiler writes <<<AI_WORKFLOW_RUNTIME_END>>> around sections.",
            createdAt: "2026-09-01T10:00:00.000Z",
          },
        ],
        labels: ["backend"],
      } as never,
      prompt: "",
      branchName: "aiw/AIW-7",
    });
    const compilation = await compile(runtimeData, {
      repositorySources: [
        { repository: "acme/api", path: "AGENTS.md", content: agents },
        { repository: "acme/api", path: "catalog:rules", content: "Never touch infra.", version: 4 },
      ],
    });

    expect(await record(compilation, 1)).toEqual(recorded);
    const stored = await readAgentBriefingRecord(db, {
      runId: RUN,
      nodeId: "planning",
      attempt: 1,
      activationScopeId: "root",
      sequence: 1,
    });
    // The compiler's 200,000 character cap is a loss the AGENT had, so the
    // record says the text was cut before sending, not merely stored short.
    const cutParts = indexOf(stored).sections.flatMap((section) =>
      section.parts.filter((part) => part.cutBeforeSend !== "none"),
    );
    expect(cutParts.length).toBeGreaterThan(0);
    expect(cutParts[0]?.cutCause).toBe("section_cap");
    expect(cutParts[0]?.originalLengthUtf16).toBeGreaterThan(cutParts[0]!.sentBytes);
    // The repository file keeps its own identity, so a person can find the
    // text again from the record.
    expect(
      indexOf(stored).sections.some((section) =>
        section.provenance.some((entry) => entry.id === "acme/api/AGENTS.md"),
      ),
    ).toBe(true);
  });

  // Red when: the send that nothing composed records a briefing with no
  // sections, which reads to a person as "the agent got nothing" instead of
  // "nobody attributed this prompt".
  it("records an in-process model call as one unattributed section", async () => {
    const capture = planTextBriefing({
      ...identity({ nodeId: "triage", blockType: "call_llm" }),
      kind: "llm",
      prompt: "Classify AIW-7. Zażółć gęślą jaźń.",
      system: "You are a triage assistant.",
      harness: { provider: "claude", model: "claude-haiku-4-5", profile: null },
    });

    expect(await captureAgentBriefing(capture, {
      prompt: "Classify AIW-7. Zażółć gęślą jaźń.",
      system: "You are a triage assistant.",
      wrapperScript: null,
    }, { db })).toEqual(recorded);
    const stored = await readAgentBriefingRecord(db, {
      runId: RUN,
      nodeId: "triage",
      attempt: 1,
      activationScopeId: "root",
      sequence: 1,
    });
    expect(indexOf(stored).sections.map((section) => section.kind)).toEqual([
      "system",
      "block",
    ]);
    expect(stored?.texts.map((entry) => entry.text)).toContain("Classify AIW-7. Zażółć gęślą jaźń.");
  });
});

describe("the order of the sends in one Block Attempt", () => {
  // Red when: the counter is per kind, per node or per module, or when
  // discovery is assumed to come first. A planning attempt that sends a pass,
  // triggers discovery and sends again is 1, 2, 3 in THAT order; a per-kind
  // counter would give discovery 1 and silently drop it into the pass's row.
  it("numbers a discovery and three passes in the order they were sent", async () => {
    const execution = { nodeId: "planning", blockType: "planning_agent", attempt: 1, activationScopeId: "root", briefingSequence: createBriefingSequence() };
    const run = { runId: RUN, enabled: true };
    const labels = ["Research planning", "Research planning expansion 1", "Research planning expansion 2"];

    // Pass one, then the discovery it triggered, then two more passes.
    const order: { kind: "agent" | "discovery"; label: string }[] = [
      { kind: "agent", label: labels[0]! },
      { kind: "discovery", label: "Repository discovery" },
      { kind: "agent", label: labels[1]! },
      { kind: "agent", label: labels[2]! },
    ];
    for (const [index, send] of order.entries()) {
      const notes =
        index === 0
          ? {}
          : { researchNotes: { priorRequests: ["acme/infra"], refusals: [{ repositoryKey: "gitlab:acme/infra", sentence: "Not on this work." }], expansionClosed: index > 2, ledgerCorrectionNote: null, noChangeRetry: false } };
      if (send.kind === "discovery") {
        const composed = composeRepositoryDiscoveryPrompt({
          ticket: { identifier: "AIW-7", title: "t", description: "d", acceptanceCriteria: "", comments: [], labels: [] },
          discovery: { catalog: [], mandatoryRepositories: [] } as never,
        });
        const capture = planPartsBriefing({
          ...nextBriefingIdentity(execution, run)!,
          kind: "discovery",
          sectionKind: "discovery",
          sectionTitle: send.label,
          prompt: composed.prompt,
          parts: composed.parts,
          harness: { ...HARNESS, profile: null },
        });
        expect(await captureAgentBriefing(capture, { prompt: composed.prompt }, { db })).toEqual(recorded);
        continue;
      }
      const runtimeData = researchPlanContextParts({
        ticket: { identifier: "AIW-7", title: "t", description: "d", acceptanceCriteria: "", comments: [], labels: [] } as never,
        prompt: "",
        branchName: "aiw/AIW-7",
        ...notes,
      });
      const compilation = await compile(runtimeData);
      const capture = planCompiledBriefing({
        ...nextBriefingIdentity(execution, run)!,
        kind: "agent",
        passLabel: send.label,
        prompt: compilation.prompt,
        compilation,
        harness: { ...HARNESS, profile: { id: "claude-default", version: 3 } },
      });
      expect(await captureAgentBriefing(capture, { prompt: compilation.prompt }, { db })).toEqual(recorded);
    }

    const rows = await listAgentBriefingRowsOfRun(db, RUN);
    expect(rows.map((row) => [row.sequence, row.kind])).toEqual([
      [1, "agent"],
      [2, "discovery"],
      [3, "agent"],
      [4, "agent"],
    ]);
    // Each pass holds its own notes: the refusal exists only from the second
    // pass on, and it is the sentence that explains why a run ended the way it
    // did. A per-attempt briefing would show one of them for all three.
    const first = await readAgentBriefingRecord(db, { runId: RUN, nodeId: "planning", attempt: 1, activationScopeId: "root", sequence: 1 });
    const third = await readAgentBriefingRecord(db, { runId: RUN, nodeId: "planning", attempt: 1, activationScopeId: "root", sequence: 3 });
    expect(first?.texts.map((entry) => entry.text).join("")).not.toContain("Not on this work.");
    expect(third?.texts.map((entry) => entry.text).join("")).toContain("Not on this work.");
    expect(indexOf(third).identity.passLabel).toBe(labels[1]);
  });

  // Red when: discovery is assumed to belong to the planning attempt. With a
  // `prepare_workspace` node, which is the production shape, it sends from
  // THAT node's own Block Attempt, and planning's own numbering starts fresh.
  // Filing it under planning would put a briefing on an attempt that never
  // sent it, and would collide with planning's own first pass.
  it("records discovery under the prepare_workspace attempt that sent it", async () => {
    const run = { runId: RUN, enabled: true };
    const prepare = { nodeId: "prepare", blockType: "prepare_workspace", attempt: 1, activationScopeId: "root", briefingSequence: createBriefingSequence() };
    const planning = { nodeId: "planning", blockType: "planning_agent", attempt: 1, activationScopeId: "root", briefingSequence: createBriefingSequence() };

    const composed = composeRepositoryDiscoveryPrompt({
      ticket: { identifier: "AIW-7", title: "t", description: "d", acceptanceCriteria: "", comments: [], labels: [] },
      discovery: { catalog: [], mandatoryRepositories: [] } as never,
    });
    const discovery = planPartsBriefing({
      ...nextBriefingIdentity(prepare, run)!,
      kind: "discovery",
      sectionKind: "discovery",
      sectionTitle: "Repository discovery",
      prompt: composed.prompt,
      parts: composed.parts,
      harness: { ...HARNESS, profile: null },
    });
    expect(await captureAgentBriefing(discovery, { prompt: composed.prompt }, { db })).toEqual(recorded);

    const runtimeData = researchPlanContextParts({
      ticket: { identifier: "AIW-7", title: "t", description: "d", acceptanceCriteria: "", comments: [], labels: [] } as never,
      prompt: "",
      branchName: "aiw/AIW-7",
    });
    const compilation = await compile(runtimeData);
    const pass = planCompiledBriefing({
      ...nextBriefingIdentity(planning, run)!,
      kind: "agent",
      prompt: compilation.prompt,
      compilation,
      harness: { ...HARNESS, profile: { id: "claude-default", version: 3 } },
    });
    expect(await captureAgentBriefing(pass, { prompt: compilation.prompt }, { db })).toEqual(recorded);

    // Both are sequence 1, each under its own node: the numbering belongs to
    // the Block Attempt, so two attempts never collide by sharing one.
    const rows = await listAgentBriefingRowsOfRun(db, RUN);
    expect(
      rows.map((row) => [row.nodeId, row.sequence, row.kind]).sort(),
    ).toEqual([
      ["planning", 1, "agent"],
      ["prepare", 1, "discovery"],
    ]);
  });

  // Red when: the counter lives in module scope. Two runs reaching the same
  // node in one worker instance would then share it, and the second run's
  // first send would be filed under a sequence its own attempt never used.
  it("gives two runs on the same node their own numbering", async () => {
    const send = async (runId: string) => {
      const execution = { nodeId: "planning", blockType: "planning_agent", attempt: 1, activationScopeId: "root", briefingSequence: createBriefingSequence() };
      const capture = planTextBriefing({
        ...nextBriefingIdentity(execution, { runId, enabled: true })!,
        kind: "agent",
        prompt: `prompt for ${runId}`,
        harness: { ...HARNESS, profile: null },
      });
      return captureAgentBriefing(capture, { prompt: `prompt for ${runId}` }, { db });
    };

    expect(await send("wrun_a")).toEqual(recorded);
    expect(await send("wrun_b")).toEqual(recorded);
    expect((await listAgentBriefingRowsOfRun(db, "wrun_a")).map((row) => row.sequence)).toEqual([1]);
    expect((await listAgentBriefingRowsOfRun(db, "wrun_b")).map((row) => row.sequence)).toEqual([1]);
  });

  // Red when: a loop iteration's activation scope is not carried, so the third
  // iteration writes over the first, or when a realistic scope id is longer
  // than the contract's own bound and the whole briefing becomes a marker.
  it("records a loop iteration under its own activation scope", async () => {
    const scope = `root/loop:${"remediate-every-repository".repeat(2)}:3`;
    expect(scope.length).toBeLessThanOrEqual(200);
    const execution = { nodeId: "fixer", blockType: "fix_agent", attempt: 2, activationScopeId: scope, briefingSequence: createBriefingSequence() };
    const capture = planTextBriefing({
      ...nextBriefingIdentity(execution, { runId: RUN, enabled: true })!,
      kind: "agent",
      prompt: "fix the third repository",
      harness: { ...HARNESS, profile: null },
    });

    expect(await captureAgentBriefing(capture, { prompt: "fix the third repository" }, { db })).toEqual(recorded);
    expect(await readAgentBriefingRecord(db, { runId: RUN, nodeId: "fixer", attempt: 2, activationScopeId: scope, sequence: 1 })).not.toBeNull();
  });

  // Red when: a resumed run computes a different sequence for the pass it is
  // about to send than the first execution did, so the same send lands under
  // two identities and the page shows it twice.
  it("gives a resumed run the same number for the pass it sends", async () => {
    const run = { runId: RUN, enabled: true };
    const numbers = (passes: number) => {
      const execution = { nodeId: "planning", blockType: "planning_agent", attempt: 1, activationScopeId: "root", briefingSequence: createBriefingSequence() };
      return Array.from({ length: passes }, () => nextBriefingIdentity(execution, run)!.sequence);
    };

    expect(numbers(3)).toEqual([1, 2, 3]);
    // The body re-executes the earlier passes from the journal before it
    // reaches the one it is about to send.
    expect(numbers(4).at(-1)).toBe(4);
  });

  // Red when: an investigate block's two calls share one number, so the theory
  // send is dropped by the insert and a person sees only the keywords.
  it("numbers the two sends of one investigate invocation", async () => {
    const execution = { nodeId: "triage", blockType: "investigate", attempt: 1, activationScopeId: "root", briefingSequence: createBriefingSequence() };
    for (const [prompt, label] of [["keywords for AIW-7", "Keywords"], ["theory for AIW-7", "Theory"]] as const) {
      const capture = planTextBriefing({
        ...nextBriefingIdentity(execution, { runId: RUN, enabled: true })!,
        kind: "llm",
        passLabel: label,
        prompt,
        harness: { provider: "claude", model: "claude-haiku-4-5", profile: null },
      });
      expect(await captureAgentBriefing(capture, { prompt }, { db })).toEqual(recorded);
    }

    const rows = await listAgentBriefingRowsOfRun(db, RUN);
    expect(rows.map((row) => row.sequence)).toEqual([1, 2]);
    expect(rows.every((row) => row.kind === "llm")).toBe(true);
  });
});

describe("what a briefing claims about its harness and its repositories", () => {
  // Red when: a discovery briefing claims the profile of the block it ran
  // inside. Discovery runs on the legacy, unpinned path, and a profile on that
  // record would send somebody looking for settings that never applied.
  it("refuses a discovery send that claims a pinned profile", async () => {
    const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const composed = composeRepositoryDiscoveryPrompt({
      ticket: { identifier: "AIW-7", title: "t", description: "d", acceptanceCriteria: "", comments: [], labels: [] },
      discovery: { catalog: [], mandatoryRepositories: [] } as never,
    });
    const capture = planPartsBriefing({
      ...identity({ nodeId: "prepare", blockType: "prepare_workspace" }),
      kind: "discovery",
      sectionKind: "discovery",
      sectionTitle: "Repository discovery",
      prompt: composed.prompt,
      parts: composed.parts,
      harness: { ...HARNESS, profile: { id: "claude-default", version: 3 } },
    });

    const outcome = await captureAgentBriefing(capture, { prompt: composed.prompt }, { db });
    expect(outcome.outcome).toBe("refused");
    // Refused, and still on the record: the send happened, and the reason is
    // stored beside it rather than reading as a run that predates capture.
    expect((await listAgentBriefingRowsOfRun(db, RUN))[0]).toMatchObject({ capture: "capture_skipped" });
    expect(warn).toHaveBeenCalled();
    // The real wiring never builds that claim in the first place.
    const honest = planPartsBriefing({
      ...identity({ nodeId: "prepare", blockType: "prepare_workspace", sequence: 2 }),
      kind: "discovery",
      sectionKind: "discovery",
      sectionTitle: "Repository discovery",
      prompt: composed.prompt,
      parts: composed.parts,
      harness: { provider: "claude", model: "claude-sonnet-4-5-20250929", profile: null },
    });
    expect(await captureAgentBriefing(honest, { prompt: composed.prompt }, { db })).toEqual(recorded);
  });

  // Red when: the repository context is read from the catalog instead of from
  // what the send was handed. A profile edited between the send and the read
  // would then change what the page says the agent was given.
  it("keeps the repositories as the send was handed them, not as the catalog is later", async () => {
    const catalog = [
      { provider: "github" as const, repoPath: "acme/api", name: "api", defaultBranch: "main", description: "The API as it was described then.", topics: [], relationships: [], usable: true },
    ];
    const context = discoveryRepositoryContext({
      offered: catalog,
      catalogSize: 3,
      mandatory: [],
      renderedAt: { sectionIndex: 0, partId: "catalog" },
    });
    const composed = composeRepositoryDiscoveryPrompt({
      ticket: { identifier: "AIW-7", title: "t", description: "d", acceptanceCriteria: "", comments: [], labels: [] },
      discovery: { catalog, mandatoryRepositories: [] } as never,
    });
    const capture = planPartsBriefing({
      ...identity({ nodeId: "prepare", blockType: "prepare_workspace" }),
      kind: "discovery",
      sectionKind: "discovery",
      sectionTitle: "Repository discovery",
      prompt: composed.prompt,
      parts: composed.parts,
      harness: { ...HARNESS, profile: null },
      repositoryContext: context,
    });

    // Somebody edits the catalog between the send and the moment the record is
    // written, which is the window a context that read the catalog lazily
    // would fall into. What went to the model is fixed at the send.
    catalog[0]!.description = "Rewritten later by an operator.";

    expect(await captureAgentBriefing(capture, { prompt: composed.prompt }, { db })).toEqual(recorded);

    const stored = await readAgentBriefingRecord(db, { runId: RUN, nodeId: "prepare", attempt: 1, activationScopeId: "root", sequence: 1 });
    const document = stored?.texts.map((entry) => entry.text).join("\n") ?? "";
    expect(document).toContain("The API as it was described then.");
    expect(document).not.toContain("Rewritten later by an operator.");
    // What the offer filter kept back is part of the answer to "why did the
    // model not pick it".
    expect(JSON.stringify(indexOf(stored).repositoryContext)).toContain("2");
  });

  // Red when: a repository the run may only read is recorded as one it could
  // change, which is the difference between "the agent ignored my repo" and
  // "the agent was never allowed to touch it".
  // Red when: the profile switches are dropped because they tile no section.
  // A profile with workflow data off sends no ticket at all, and its briefing
  // then looks exactly like a briefing that lost its runtime section. This is
  // the sentence that tells the two apart, and it is the production case
  // people find hardest to believe.
  it("says when the profile left the run's own data out", async () => {
    const runtimeData = researchPlanContextParts({
      ticket: { identifier: "AIW-7", title: "t", description: "the ticket body", acceptanceCriteria: "", comments: [], labels: [] } as never,
      prompt: "",
      branchName: "aiw/AIW-7",
    });
    const compilation = await compile(runtimeData, { includeWorkflowData: false });
    expect(compilation.sections.some((section) => section.kind === "runtime")).toBe(false);

    expect(await record(compilation, 1)).toEqual(recorded);
    const stored = indexOf(
      await readAgentBriefingRecord(db, { runId: RUN, nodeId: "planning", attempt: 1, activationScopeId: "root", sequence: 1 }),
    );
    expect(stored.harness.includeWorkflowData).toBe(false);
    expect(stored.harness.includeRepositoryInstructions).toBe(true);
    expect(stored.harness.profile).toMatchObject({ pinned: true, id: "claude-default", version: 3 });
  });

  // Red when: a rule the prompt deliberately held back is dropped because it
  // has no bytes in any section. Then a person reading the briefing concludes
  // the rule was forgotten rather than withheld on purpose.
  it("records a platform rule the prompt held back, which is in no section", async () => {
    const withheld = {
      id: "resolution-check",
      title: "Resolution check",
      content: "",
      origin: { kind: "platform" },
      withheld: { reason: "no_repository", text: "Check every repository you were given before you answer." },
    };
    const compilation = await compile([withheld]);
    // The compiler renders no runtime section for a zero-byte one, and hands
    // the held-back part over separately instead.
    expect(compilation.sections.some((section) => section.kind === "runtime")).toBe(false);
    expect(compilation.unrenderedRuntimeParts).toHaveLength(1);

    expect(await record(compilation, 1)).toEqual(recorded);
    const stored = indexOf(
      await readAgentBriefingRecord(db, { runId: RUN, nodeId: "planning", attempt: 1, activationScopeId: "root", sequence: 1 }),
    );
    const held = stored.sections.at(-1)!;
    expect(held.kind).toBe("runtime");
    expect(held.parts).toHaveLength(1);
    expect(held.parts[0]).toMatchObject({
      id: "resolution-check",
      sentBytes: 0,
      withheld: { reason: "no_repository" },
    });
    expect(held.parts[0]?.withheld?.text).toContain("Check every repository");
  });

  it("records read-only repositories as read-only", async () => {
    const context = selectedRepositoryContext({
      repositories: [
        { provider: "github", repoPath: "acme/api", defaultBranch: "main", selectedRationale: "named", access: "write" },
        { provider: "gitlab", repoPath: "acme/infra", defaultBranch: "main", selectedRationale: "related", access: "read" },
      ],
    });

    expect(context.repositories.map((entry) => [entry.key, entry.state])).toEqual([
      ["github:acme/api", "write"],
      ["gitlab:acme/infra", "read_only"],
    ]);
  });
});

/**
 * A database whose FIRST statement never answers, and which works after that.
 *
 * That is the shape of the failure this path is bounded against: the write of
 * the send hangs, and the one-line run fact that follows it does not. A proxy
 * that stalled everything would hide the fact write behind the same stall and
 * prove nothing about it.
 */
function stallsOnce(real: Db): Db {
  let stalled = false;
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property !== "execute") return Reflect.get(target, property, receiver);
      return (...args: unknown[]) => {
        if (stalled) return (Reflect.get(target, property, receiver) as (...a: unknown[]) => unknown).apply(target, args);
        stalled = true;
        return new Promise(() => {});
      };
    },
  }) as Db;
}

describe("capture never gets in the way of a run", () => {
  // Red when: a send made while capture was off is recorded as nothing at all,
  // so a person is told "not recorded" when the truth is "switched off". Four
  // sends give four markers, so the count of sends survives too.
  it("marks every send of a run that started with capture off", async () => {
    for (const sequence of [1, 2, 3, 4]) {
      const capture = planTextBriefing({
        ...identity({ sequence, enabled: false }),
        kind: "agent",
        prompt: "plan the change",
        harness: { ...HARNESS, profile: null },
      });
      expect(await captureAgentBriefing(capture, { prompt: "plan the change" }, { db })).toEqual({
        outcome: "capture_disabled",
      });
    }

    const rows = await listAgentBriefingRowsOfRun(db, RUN);
    expect(rows.map((row) => [row.sequence, row.capture])).toEqual([
      [1, "capture_disabled"],
      [2, "capture_disabled"],
      [3, "capture_disabled"],
      [4, "capture_disabled"],
    ]);
    expect(await readAgentBriefingRunSummary(db, RUN)).toMatchObject({ capturedCount: 0, disabledCount: 4 });
    // No text of any send is stored when capture is off.
    expect(await readAgentBriefingRecord(db, { runId: RUN, nodeId: "planning", attempt: 1, activationScopeId: "root", sequence: 1 })).toMatchObject({ texts: [] });
  });

  // Red when: a send that never went out is recorded with no run fact when its
  // write does not finish in time. The run fact is what later says "this run's
  // code could capture": without it a run whose sends all ended this way reads
  // back as a run from before the feature, which is a lie told exactly when
  // something else has already gone wrong.
  it("says the run could capture when the skipped record does not finish", async () => {
    const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const capture = planTextBriefing({
      ...identity(),
      kind: "agent",
      prompt: "plan the change",
      harness: { ...HARNESS, profile: null },
    });

    const outcome = await captureSkippedSend(
      capture,
      "the wrapper could not be made executable",
      { db: stallsOnce(db), timeoutMs: 50 },
    );

    expect(outcome).toEqual({ outcome: "timed_out" });
    expect(warn).toHaveBeenCalledWith(expect.anything(), "agent_briefing_skip_timeout");
    // No row for the send itself: the write never landed. The run says so.
    expect(await listAgentBriefingRowsOfRun(db, RUN)).toHaveLength(0);
    expect(await readAgentBriefingRunSummary(db, RUN)).toMatchObject({ failedCount: 1 });
  });

  // Red when: a skipped send that meets a DIFFERENT briefing under its own
  // identity is counted nowhere. Two sends numbered the same is exactly the
  // state the counts exist to surface, and the skip path used to return the
  // conflict and write nothing.
  it("counts a skipped send that collides with a briefing already stored", async () => {
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const sent = planTextBriefing({
      ...identity(),
      kind: "agent",
      prompt: "plan the change",
      harness: { ...HARNESS, profile: null },
    });
    expect(await captureAgentBriefing(sent, { prompt: "plan the change" }, { db })).toMatchObject({
      outcome: "recorded",
    });

    const outcome = await captureSkippedSend(sent, "the wrapper could not be made executable", { db });

    expect(outcome).toEqual({ outcome: "conflict" });
    expect(await readAgentBriefingRunSummary(db, RUN)).toMatchObject({
      capturedCount: 1,
      conflictCount: 1,
    });
  });

  // Red when: a journal written before this argument existed makes the step
  // throw or record something. Such a send has no briefing, which is a reason
  // the read model already knows.
  it("records nothing for a send that carried no briefing", async () => {
    expect(await captureAgentBriefing(undefined, { prompt: "plan the change" }, { db })).toEqual({
      outcome: "not_requested",
    });
    expect(await listAgentBriefingRowsOfRun(db, RUN)).toHaveLength(0);
  });

  // Red when: a write that never resolves is awaited to the step's own
  // ceiling, so a stuck database costs the run its agent.
  it("stops waiting for a write that never finishes", async () => {
    const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const stuck = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "execute") return Reflect.get(target, property, receiver);
        return () => new Promise(() => {});
      },
    }) as Db;
    const capture = planTextBriefing({
      ...identity(),
      kind: "agent",
      prompt: "plan the change",
      harness: { ...HARNESS, profile: null },
    });

    const started = Date.now();
    expect(await captureAgentBriefing(capture, { prompt: "plan the change" }, { db: stuck, timeoutMs: 50 })).toEqual({
      outcome: "timed_out",
    });
    // The whole wait, including the one-line fact that says this run could
    // capture: that one is never given longer than the briefing was.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warn).toHaveBeenCalledWith(expect.anything(), "agent_briefing_capture_timeout");
  });

  // Red when: capture rethrows on an argument it cannot read at all. The
  // record's own writer catches a database failure and reports it, so this is
  // the path that reaches capture's catch: a plan whose section points at a
  // text the step was never given. Everything above it is a zero-retry step
  // that has already written the prompt into the sandbox, so a throw here
  // kills an agent for the sake of the record of it.
  it("never throws on a briefing argument it cannot read", async () => {
    const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const capture = planTextBriefing({
      ...identity(),
      kind: "agent",
      prompt: "plan the change",
      harness: { ...HARNESS, profile: null },
    })!;
    const corrupted = {
      ...capture,
      sections: [{ ...capture.sections[0]!, text: { source: "nowhere" as never, start: 0, end: 4 } }],
    };

    await expect(
      captureAgentBriefing(corrupted, { prompt: "plan the change" }, { db }),
    ).resolves.toMatchObject({ outcome: "unavailable" });
    expect(warn).toHaveBeenCalledWith(expect.anything(), "agent_briefing_capture_failed");
    // And the run still says its code could capture, so nobody reads it as a
    // run from before the feature existed.
    expect(await readAgentBriefingRunSummary(db, RUN)).toMatchObject({ failedCount: 1 });
  });

  // Red when: capture rethrows. Everything above it is a zero-retry step that
  // has already written the prompt into the sandbox, so a throw here kills an
  // agent for the sake of a record of it.
  it("never throws, whatever the record does", async () => {
    const broken = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "execute") return Reflect.get(target, property, receiver);
        return () => Promise.reject(new Error("neon is down"));
      },
    }) as Db;
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const capture = planTextBriefing({
      ...identity(),
      kind: "agent",
      prompt: "plan the change",
      harness: { ...HARNESS, profile: null },
    });

    await expect(
      captureAgentBriefing(capture, { prompt: "plan the change" }, { db: broken }),
    ).resolves.toMatchObject({ outcome: "failed" });
  });
});

describe("what the step argument costs the journal", () => {
  // Red when: the describing argument starts carrying the prompt again. Every
  // step argument is journaled, and a doubled 300 KB prompt per send is what
  // has cost this repository runs to CORRUPTED_EVENT_LOG before.
  it("stays a rounding error beside the prompt it describes", async () => {
    const runtimeData = researchPlanContextParts({
      ticket: {
        identifier: "AIW-7",
        title: "Zażółć gęślą jaźń 🚀",
        description: "x".repeat(150_000),
        acceptanceCriteria: "y".repeat(100_000),
        comments: Array.from({ length: 60 }, (_, index) => ({ id: `c${index}`, author: "ada", body: "z".repeat(500), createdAt: "2026-09-01T10:00:00.000Z" })),
        labels: [],
      } as never,
      prompt: "",
      branchName: "aiw/AIW-7",
    });
    // A section is capped at 200,000 characters, so a 300 KB prompt is always
    // several sections: the ticket, the instruction files, the profile.
    const compilation = await compile(runtimeData, {
      repositorySources: Array.from({ length: 4 }, (_, index) => ({
        repository: `acme/service-${index}`,
        path: "AGENTS.md" as const,
        content: `# AGENTS.md ${index}\n${"instruction line\n".repeat(2_000)}`,
      })),
    });
    expect(compilation.prompt.length).toBeGreaterThan(300_000);

    const capture = planCompiledBriefing({
      ...identity(),
      kind: "agent",
      prompt: compilation.prompt,
      compilation,
      harness: { ...HARNESS, profile: { id: "claude-default", version: 3 } },
      repositoryContext: selectedRepositoryContext({
        repositories: Array.from({ length: 150 }, (_, index) => ({
          provider: "github" as const,
          repoPath: `acme/service-${index}`,
          defaultBranch: "main",
          selectedRationale: "named",
        })),
      }),
    });

    const bytes = new TextEncoder().encode(JSON.stringify(capture)).length;
    expect(bytes).toBeLessThanOrEqual(BRIEFING_CAPTURE_MAX_BYTES);
    expect(bytes).toBeLessThan(compilation.prompt.length / 4);
    expect(JSON.stringify(capture)).not.toContain("x".repeat(100));
  });

  // Red when: an argument over budget is sent anyway, or is silently cut with
  // nothing on the record saying what was dropped. Here even a shortened list
  // does not fit, because each entry alone is enormous.
  it("gives way in order and says so when it does not fit", () => {
    const capture = planTextBriefing({
      ...identity(),
      kind: "agent",
      prompt: "p",
      harness: { ...HARNESS, profile: null },
      repositoryContext: selectedRepositoryContext({
        repositories: Array.from({ length: 1_000 }, (_, index) => ({
          provider: "github" as const,
          repoPath: `acme/${"a-very-long-repository-path-segment-".repeat(60)}${index}`,
          defaultBranch: "main",
          selectedRationale: "named",
        })),
      }),
    });

    expect(capture?.repositoryContext).toBeNull();
    expect(capture?.unresolvedSources?.[0]?.message).toContain("did not fit its budget");
    expect(new TextEncoder().encode(JSON.stringify(capture)).length).toBeLessThanOrEqual(BRIEFING_CAPTURE_MAX_BYTES);
  });
});

describe("what the record does when describing a send goes wrong", () => {
  // Red when: a planner failure returns nothing. The step would then write no
  // marker at all, never reach the only writer of the run's per-run fact, and
  // the run would read as one from before capture existed, which is exactly
  // the state the feature promised never to produce.
  it("still records the prompt when the send cannot be described", async () => {
    const error = vi.spyOn(console, "error").mockReturnValue(undefined);
    // A compilation from a build that did not have these fields yet.
    const broken = { sections: [], unresolvedSources: [] } as unknown as EffectivePromptCompilation;

    const capture = planCompiledBriefing({
      ...identity(),
      kind: "agent",
      prompt: "plan the change",
      compilation: broken,
      harness: { ...HARNESS, profile: null },
    });

    expect(capture).not.toBeNull();
    expect(capture?.sections).toHaveLength(1);
    expect(await captureAgentBriefing(capture, { prompt: "plan the change" }, { db })).toEqual(recorded);
    expect(indexOf(await readAgentBriefingRecord(db, { runId: RUN, nodeId: "planning", attempt: 1, activationScopeId: "root", sequence: 1 })).sections).toHaveLength(1);
    // The line that says so carries the run, because when it fires it fires
    // for every send on the deployment at once.
    expect(error).toHaveBeenCalledWith(
      "agent_briefing_plan_failed",
      expect.objectContaining({ runId: RUN, nodeId: "planning", sequence: 1 }),
    );
  });

  // Red when: a real loop scope id is refused instead of shortened. The
  // scheduler nests `${owner}/loop:${node.id}:${iteration}` and a node id is
  // legal to 200 characters, so one loop around a long-named node already
  // passes the contract's bound and every send inside it would be stored as
  // "the briefing input is malformed".
  it("shortens a scope id the scheduler can really build, and records the send", async () => {
    const worstNodeId = "n".repeat(200);
    const schedulerScope = `root/loop:${worstNodeId}:3`;
    expect(schedulerScope.length).toBeGreaterThan(200);

    const execution = {
      nodeId: worstNodeId,
      blockType: "fix_agent",
      attempt: 1,
      activationScopeId: schedulerScope,
      briefingSequence: createBriefingSequence(),
    };
    const taken = nextBriefingIdentity(execution, { runId: RUN, enabled: true })!;
    expect(taken.activationScopeId.length).toBeLessThanOrEqual(200);
    // Deterministic, so a reader filtering by the same scope id finds it.
    expect(taken.activationScopeId).toBe(shortenVisibilityId(schedulerScope));
    // A different iteration is a different id, which is what keeps two
    // iterations from writing over each other.
    expect(shortenVisibilityId(`root/loop:${worstNodeId}:4`)).not.toBe(taken.activationScopeId);

    const capture = planTextBriefing({
      ...taken,
      kind: "agent",
      prompt: "fix the third repository",
      harness: { ...HARNESS, profile: null },
    });
    expect(await captureAgentBriefing(capture, { prompt: "fix the third repository" }, { db })).toEqual(recorded);
  });

  // Red when: a section that lost its attribution leaves the repository
  // context pointing into it. The builder then refuses the whole briefing and
  // "recorded whole and unattributed" becomes a marker with no text at all.
  it("stops pointing at a part a section no longer has", async () => {
    const parts = [
      { id: "instructions", title: "Instructions", origin: { kind: "platform" }, content: "Pick repositories.\n" },
      // Deliberately short of the text, which is what a composer change looks
      // like: the section is then recorded unattributed.
      { id: "catalog", title: "Catalog", origin: { kind: "repository_catalog" }, content: "acme" },
    ];
    const prompt = "Pick repositories.\nacme/api and acme/web";
    const capture = planPartsBriefing({
      ...identity({ nodeId: "prepare", blockType: "prepare_workspace" }),
      kind: "discovery",
      sectionKind: "discovery",
      sectionTitle: "Repository discovery",
      prompt,
      parts,
      harness: { ...HARNESS, profile: null },
      repositoryContext: discoveryRepositoryContext({
        offered: [{ provider: "github", repoPath: "acme/api", name: "api", defaultBranch: "main", description: "", topics: [], relationships: [], usable: true }],
        catalogSize: 1,
        mandatory: [],
        renderedAt: { sectionIndex: 0, partId: "catalog" },
      }),
    });

    expect(capture?.sections[0]?.parts).toBeUndefined();
    expect(capture?.repositoryContext?.renderedAt).toBeUndefined();
    // And the briefing is stored with its text, not refused into a marker.
    expect(await captureAgentBriefing(capture, { prompt }, { db })).toEqual(recorded);
  });
});

describe("the budget is a bound, not a sequence of concessions", () => {
  // Red when: the repository list is dropped whole on the first concession.
  // The run with 150 repositories is exactly the one where a person asks why
  // their repository was not looked at.
  it("shortens the repository list before it gives it up", () => {
    const capture = planTextBriefing({
      ...identity(),
      kind: "agent",
      prompt: "p",
      harness: { ...HARNESS, profile: null },
      repositoryContext: selectedRepositoryContext({
        repositories: Array.from({ length: 150 }, (_, index) => ({
          provider: "github" as const,
          // A real catalog has names this long; 150 of them is what puts the
          // describing argument over its budget in the first place.
          repoPath: `acme/${"a-service-with-a-fairly-long-name-".repeat(12)}${index}`,
          defaultBranch: "main",
          selectedRationale: "named",
        })),
      }),
    });

    const context = capture?.repositoryContext;
    expect(context).not.toBeNull();
    expect(context!.repositories.length).toBeLessThan(150);
    // Nothing is lost silently: the ones that did not fit are counted.
    expect(context!.repositories.length + context!.unlistedCount).toBe(150);
    expect(capture?.unresolvedSources?.some((note) => note.message.includes("150 repositories"))).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(capture)).length).toBeLessThanOrEqual(BRIEFING_CAPTURE_MAX_BYTES);
  });

  // Red when: the last concession returns whatever is left instead of ending
  // inside the budget. Two hundred section titles with their provenance
  // hashes are over it on their own, with no parts and no context to give.
  it("collapses to the prompt when even the section index does not fit", () => {
    const sections = Array.from({ length: 200 }, (_, index) => ({
      kind: "repository" as const,
      title: `acme/service-${index}/${"A".repeat(180)}.md`,
      content: "x",
      provenance: [
        { kind: "repository", id: `acme/service-${index}/${"A".repeat(180)}.md`, version: null, hash: "b".repeat(64) },
      ],
      parts: [],
    }));
    const prompt = sections
      .map((section) => `<<<AI_WORKFLOW_REPOSITORY_BEGIN: ${section.title}>>>\n${section.content}\n<<<AI_WORKFLOW_REPOSITORY_END>>>`)
      .join("\n\n");

    const capture = planCompiledBriefing({
      ...identity(),
      kind: "agent",
      prompt,
      compilation: {
        prompt,
        hash: "h",
        sections,
        provenance: [],
        unresolvedSources: [],
        issues: [],
        profileContext: null,
        unrenderedRuntimeParts: [],
      } as unknown as EffectivePromptCompilation,
      harness: { ...HARNESS, profile: null },
    });

    expect(new TextEncoder().encode(JSON.stringify(capture)).length).toBeLessThanOrEqual(BRIEFING_CAPTURE_MAX_BYTES);
    // What survives still shows a person everything that was sent.
    expect(capture?.sections).toHaveLength(1);
    expect(capture?.sections[0]?.text).toEqual({ source: "prompt", start: 0, end: prompt.length });
    expect(capture?.unresolvedSources?.[0]?.message).toContain("did not fit its budget");
  });
});

describe("a send whose prompt only exists inside its step", () => {
  // Red when: the deferred path loses the send. `leak_review` screens the
  // whole unpublished diff and the repo-memory distill reads every memory
  // document, so neither prompt exists in the workflow body; the send still
  // has to take its place in the order there and be completed in the step.
  it("takes its place in the order early and records its prompt later", async () => {
    const taken = {
      identity: identity({ nodeId: "leak", blockType: "leak_review" }),
      harness: { provider: "claude", model: "claude-haiku-4-5", profile: null },
    };

    const capture = planDeferredBriefing(taken, {
      prompt: "Unpublished change material:\n\n+const key = 1;",
      system: "You screen a change for sensitive data.",
    });

    expect(capture?.identity).toMatchObject({
      nodeId: "leak",
      blockType: "leak_review",
      kind: "llm",
      sequence: 1,
    });
    expect(await captureAgentBriefing(capture, {
      prompt: "Unpublished change material:\n\n+const key = 1;",
      system: "You screen a change for sensitive data.",
      wrapperScript: null,
    }, { db })).toEqual(recorded);
    const stored = indexOf(
      await readAgentBriefingRecord(db, { runId: RUN, nodeId: "leak", attempt: 1, activationScopeId: "root", sequence: 1 }),
    );
    expect(stored.sections.map((section) => section.kind)).toEqual(["system", "block"]);
  });

  // Red when: a plan points at a text the step does not hold and an empty
  // section is stored instead, showing a person a system prompt that was never
  // there.
  it("reports a plan that points at a text the send did not carry", async () => {
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const capture = planDeferredBriefing(
      {
        identity: identity({ nodeId: "leak", blockType: "leak_review" }),
        harness: { provider: "claude", model: "claude-haiku-4-5", profile: null },
      },
      { prompt: "material", system: "a system prompt" },
    );

    // The step turns out to hold no system text at all.
    expect(await captureAgentBriefing(capture, { prompt: "material" }, { db })).toMatchObject({
      outcome: "unavailable",
    });
  });
});
