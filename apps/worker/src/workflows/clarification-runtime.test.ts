import { describe, expect, it } from "vitest";
import type { WorkspacePublicationResult } from "./workspace-publication.js";
import {
  appendClarificationRound,
  restoreClarificationRuntimeState,
} from "./agent.js";

describe("clarification continuation runtime state", () => {
  it("restores every predecessor-owned value consumed by downstream blocks and telemetry", () => {
    const publication: WorkspacePublicationResult = {
      status: "published",
      attemptId: "attempt-96",
      repositories: [],
      pushResult: { pushed: true, repositories: [] },
      prs: [{
        provider: "github",
        repoPath: "acme/api",
        id: 96,
        url: "https://github.com/acme/api/pull/96",
        branch: "codex/aiw-96",
        isNew: true,
      }],
    };
    const firstRound = {
      questions: ["Which region?"],
      answer: "eu-central",
      answeredBy: "Alice",
      answeredAt: "2026-07-18T00:00:00.000Z",
    };
    const phaseUsage = {
      cost_usd: null,
      tokens: { input: 100, cached_input: 25, output: 50 },
      duration_ms: 60_000,
      duration_api_ms: 55_000,
      num_turns: 2,
    };

    expect(restoreClarificationRuntimeState({
      preSandboxAdditions: { research: [], implementation: [], review: [] },
      implementationKind: "codex",
      implementationModel: "gpt-5-codex",
      publication,
      clarifications: [firstRound],
      phaseUsages: { Impl: phaseUsage },
      phaseModels: { Impl: "gpt-5-codex" },
      activeModel: "gpt-5-codex",
      prForTelemetry: null,
    })).toEqual({
      implementationKind: "codex",
      implementationModel: "gpt-5-codex",
      publication,
      clarifications: [firstRound],
      phaseUsages: { Impl: phaseUsage },
      phaseModels: { Impl: "gpt-5-codex" },
      activeModel: "gpt-5-codex",
      prForTelemetry: { url: "https://github.com/acme/api/pull/96", number: 96 },
    });
  });

  it("keeps prior ticketless rounds when the resumed block asks again", () => {
    const first = { questions: ["First choice?"], answer: "A" };
    const second = { questions: ["Second choice?"], answer: "B" };

    expect(appendClarificationRound([first], second)).toEqual([first, second]);
    expect(appendClarificationRound([first], first)).toEqual([first]);
  });

  it("defaults absent legacy runtime fields without inventing predecessor state", () => {
    expect(restoreClarificationRuntimeState({
      preSandboxAdditions: { research: [], implementation: [], review: [] },
    })).toEqual({
      implementationKind: undefined,
      implementationModel: undefined,
      publication: null,
      clarifications: undefined,
      phaseUsages: {},
      phaseModels: {},
      activeModel: undefined,
      prForTelemetry: null,
    });
  });
});
