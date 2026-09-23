/**
 * That every send site really passes a briefing, driven through the real
 * executors.
 *
 * THIS IS WHERE THE WHOLE CLAIM LIVES. Every other test here transcribes what
 * the workflow body is believed to do; none of them reaches the body itself.
 * TypeScript forces an argument to be passed at each send, not the RIGHT one:
 * `null` at one call site, or a block executor reached with no invocation
 * context, and that send stops recording forever with nothing red anywhere.
 * So these drive `execute` and assert on the briefing the step was handed: it
 * exists, it names this node and block, and it takes its own place in the
 * order.
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
import type { AgentBriefingCapture } from "./plan.js";

const mocks = vi.hoisted(() => ({
  generateStructured: vi.fn(),
  captured: [] as AgentBriefingCapture[],
  collect: vi.fn(),
  jira: vi.fn(),
  slack: vi.fn(),
}));

vi.mock("../llm.js", () => ({ generateStructured: mocks.generateStructured }));
// The retrieval step between investigate's two model calls reads deployment
// configuration; without it the block fails before it reaches the second send.
vi.mock("../../infra/vcs-config.js", () => ({
  env: { JIRA_PROJECT_KEY: "AIW", CHAT_SDK_SLACK_TOKEN: undefined },
}));
vi.mock("./capture.js", () => ({
  captureAgentBriefing: vi.fn(async (briefing: AgentBriefingCapture) => {
    mocks.captured.push(briefing);
    return { outcome: "recorded", briefingId: mocks.captured.length };
  }),
  captureSkippedSend: vi.fn(async () => ({ outcome: "refused", reason: "skipped" })),
}));

const { execute: executeCallLlm } = await import("../blocks/call-llm/execute.js");
const { execute: executeInvestigate } = await import("../blocks/investigate/execute.js");
const { makeCtx, makeInvocation, makeNode } = await import("../blocks/support/test-support.js");

/** What the step was handed, as a reader of the record would see it. */
function seen() {
  return mocks.captured.map((briefing) => ({
    nodeId: briefing.identity.nodeId,
    blockType: briefing.identity.blockType,
    kind: briefing.identity.kind,
    sequence: briefing.identity.sequence,
    passLabel: briefing.identity.passLabel,
    enabled: briefing.enabled,
    sections: briefing.sections.map((section) => section.kind),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.captured = [];
});

describe("call_llm passes the send it is making", () => {
  // Red when: the call site passes null, or stops passing the briefing at all,
  // or the executor is reached without an invocation so the plan returns null.
  it("hands its step a briefing naming the block and its place in the order", async () => {
    mocks.generateStructured.mockResolvedValue({ text: "answer", usage: null });
    const ctx = makeCtx();

    const result = await executeCallLlm(
      makeNode("call_llm", { prompt: "Classify AIW-7.", system: "You triage." }, "triage-1"),
      {},
      ctx,
      {},
      makeInvocation(ctx, { nodeId: "triage-1", blockType: "call_llm" }),
    );

    expect(result.kind).toBe("next");
    expect(seen()).toEqual([
      {
        nodeId: "triage-1",
        blockType: "call_llm",
        kind: "llm",
        sequence: 1,
        passLabel: undefined,
        enabled: true,
        // The system prompt is its own section, the prompt is the other.
        sections: ["system", "block"],
      },
    ]);
  });

  // Red when: the setting is read anywhere but the run's frozen settings, or
  // the send stops being recorded at all when capture is off. Four sends of a
  // run that started with it off still have to read as four.
  it("still names the send when the run started with capture off", async () => {
    mocks.generateStructured.mockResolvedValue({ text: "answer", usage: null });
    const ctx = makeCtx({
      settings: { ...makeCtx().settings, ENABLE_AGENT_BRIEFINGS: false },
    });

    await executeCallLlm(
      makeNode("call_llm", { prompt: "hi" }, "triage-1"),
      {},
      ctx,
      {},
      makeInvocation(ctx, { nodeId: "triage-1", blockType: "call_llm" }),
    );

    expect(mocks.captured).toHaveLength(1);
    expect(mocks.captured[0]).toMatchObject({ enabled: false, sections: [] });
  });
});

describe("investigate passes both of its sends", () => {
  // Red when: only one of the two calls is wired, or they share a sequence so
  // the second is dropped by the insert and a person sees only the keywords.
  it("hands each of its two model calls its own place in the order", async () => {
    mocks.generateStructured
      .mockResolvedValueOnce({ object: { keywords: ["cache"] }, text: "", usage: null })
      .mockResolvedValueOnce({
        object: { classification: "real_bug", theory: "A cache bug.", evidenceRefs: [] },
        text: "",
        usage: null,
      });
    const ctx = makeCtx();

    await executeInvestigate(
      makeNode("investigate", { providers: [] }, "triage-2"),
      {},
      ctx,
      {},
      makeInvocation(ctx, { nodeId: "triage-2", blockType: "investigate" }),
    );

    expect(seen()).toEqual([
      {
        nodeId: "triage-2",
        blockType: "investigate",
        kind: "llm",
        sequence: 1,
        passLabel: "Keywords",
        enabled: true,
        sections: ["block"],
      },
      {
        nodeId: "triage-2",
        blockType: "investigate",
        kind: "llm",
        sequence: 2,
        passLabel: "Theory",
        enabled: true,
        sections: ["block"],
      },
    ]);
  });
});
