import { describe, expect, it } from "vitest";
import type { WorkScope, WorkScopeActor } from "@shared/contracts";
import {
  consumeWorkScopeAsk,
  createRunWorkScopeRecorder,
  pinnedKeysOf,
  pinnedProvidersOf,
  workScopeRepositoryKey,
  type RunWorkScopeInput,
} from "./context.js";

const ACTOR: WorkScopeActor = {
  kind: "run",
  runId: "run-1",
  definitionId: 4,
  definitionVersion: 2,
};

const NOW = "2026-09-16T10:00:00.000Z";

function input(overrides: Partial<RunWorkScopeInput> = {}): RunWorkScopeInput {
  return {
    subjectKey: "ticket:jira:AWT-1",
    scope: null,
    selectionAnswered: false,
    catalog: {
      activated: true,
      enabledKeys: ["github:acme/api", "github:acme/web"],
      unusableKeys: [],
    },
    policy: { candidates: { kind: "enabled_catalog" }, expansion: "attach" },
    actor: ACTOR,
    now: NOW,
    ...overrides,
  };
}

function scopeWith(entries: WorkScope["entries"]): WorkScope {
  return { subjectKey: "ticket:jira:AWT-1", version: 3, entries };
}

describe("workScopeRepositoryKey", () => {
  it("normalises a provider and path into the catalog key the record stores", () => {
    expect(workScopeRepositoryKey({ provider: "github", repoPath: "Acme/API" })).toBe(
      "github:acme/api",
    );
  });
});

describe("pinnedProvidersOf and pinnedKeysOf", () => {
  it("read null from a pin that names nothing, so nothing is bounded by an empty list", () => {
    expect(pinnedProvidersOf(undefined)).toBeNull();
    expect(pinnedKeysOf(undefined)).toBeNull();
    expect(pinnedProvidersOf({ providers: [], repositories: [] })).toBeNull();
    expect(pinnedKeysOf({ providers: [], repositories: [] })).toBeNull();
  });

  it("reads both halves of a pin that names them", () => {
    const pin = {
      providers: ["github" as const],
      repositories: [{ provider: "github" as const, repoPath: "Acme/API" }],
    };
    expect(pinnedProvidersOf(pin)).toEqual(["github"]);
    expect(pinnedKeysOf(pin)).toEqual(["github:acme/api"]);
  });
});

describe("createRunWorkScopeRecorder", () => {
  it("keeps one event's attachments visible to the next, so the same key is not counted twice", () => {
    const recorder = createRunWorkScopeRecorder(input());

    const first = recorder.decide({
      kind: "derived",
      origin: "ticket_text",
      repositoryKeys: ["github:acme/api"],
      rationale: "ticket mentions repository path",
    });
    const second = recorder.decide({
      kind: "derived",
      origin: "inferred",
      repositoryKeys: ["github:acme/api"],
      rationale: "only accessible repository",
    });

    expect(first.attach).toEqual(["github:acme/api"]);
    expect(second.attach).toEqual([]);
    expect(recorder.attachedKeys).toEqual(["github:acme/api"]);
  });

  it("collects one write plan per event that changes something and drops the empty ones", () => {
    const recorder = createRunWorkScopeRecorder(input());

    recorder.decide({
      kind: "derived",
      origin: "ticket_text",
      repositoryKeys: ["github:acme/api"],
      rationale: "ticket mentions repository path",
    });
    recorder.decide({ kind: "run_started" });

    expect(recorder.plans).toHaveLength(1);
    expect(recorder.plans[0]?.upserts.map((upsert) => upsert.entry.repositoryKey)).toEqual([
      "github:acme/api",
    ]);
  });

  it("turns every refusal into a sentence a person can read, and says how many did not fit", () => {
    const recorder = createRunWorkScopeRecorder(
      input({
        scope: scopeWith([
          {
            repositoryKey: "github:acme/gone",
            state: "selected",
            origin: "person",
            rationale: "asked for it",
            decidedBy: { kind: "person", actorId: "p1", actorLabel: "Ada" },
            decidedAt: NOW,
          },
        ]),
      }),
    );

    recorder.decide({ kind: "run_started" });

    expect(recorder.notes).toHaveLength(1);
    expect(recorder.notes[0]).toContain("github:acme/gone");
    expect(recorder.notes[0]).toContain("catalog");
  });

  it("records what a question asked, so the ask list survives the selection", () => {
    const recorder = createRunWorkScopeRecorder(input());

    recorder.decide({
      kind: "text_ambiguous",
      matchedKeys: ["github:acme/api", "github:acme/web"],
    });

    expect(recorder.ask).toEqual([
      { repositoryKey: "github:acme/api", askedBecause: "selection" },
      { repositoryKey: "github:acme/web", askedBecause: "selection" },
    ]);
  });

  it("drops what is unreachable and what carries a blocking entry before a caller counts matches", () => {
    const recorder = createRunWorkScopeRecorder(
      input({
        catalog: {
          activated: true,
          enabledKeys: ["github:acme/api", "github:acme/web"],
          unusableKeys: ["github:acme/web"],
        },
        scope: scopeWith([
          {
            repositoryKey: "github:acme/api",
            state: "excluded",
            origin: "person",
            rationale: "not this one",
            decidedBy: { kind: "person", actorId: "p1", actorLabel: "Ada" },
            decidedAt: NOW,
          },
        ]),
      }),
    );

    expect(
      recorder.decidableKeys([
        "github:acme/api",
        "github:acme/web",
        "github:acme/absent",
      ]),
    ).toEqual([]);
  });

  it("keeps a key whose unavailable entry the catalog has since made usable", () => {
    const recorder = createRunWorkScopeRecorder(
      input({
        scope: scopeWith([
          {
            repositoryKey: "github:acme/api",
            state: "unavailable",
            unavailableReason: "not_enabled",
            origin: "person",
            rationale: "continue without it",
            decidedBy: { kind: "person", actorId: "p1", actorLabel: "Ada" },
            decidedAt: NOW,
          },
        ]),
      }),
    );

    expect(recorder.decidableKeys(["github:acme/api"])).toEqual(["github:acme/api"]);
  });

  it("bounds a key list at what one event may carry", () => {
    const keys = Array.from({ length: 12 }, (_, index) => `github:acme/repo-${index}`);
    expect(
      createRunWorkScopeRecorder(input()).boundEventKeys(keys),
    ).toHaveLength(8);
  });
});

describe("consumeWorkScopeAsk", () => {
  const ask = {
    subjectKey: "ticket:jira:AWT-1",
    askedRepositories: [
      { repositoryKey: "github:acme/api", rationale: "Ticket text names api." },
    ],
  };

  it("hands a repository question its asked repositories with their reasons", () => {
    const carrier: { workScopeAsk?: typeof ask } = { workScopeAsk: ask };

    expect(consumeWorkScopeAsk(carrier)).toEqual({
      subjectKey: "ticket:jira:AWT-1",
      askedRepositories: [
        { repositoryKey: "github:acme/api", rationale: "Ticket text names api." },
      ],
    });
  });

  it("hands a question that is not about repositories nothing", () => {
    expect(consumeWorkScopeAsk({} as { workScopeAsk?: typeof ask })).toBeUndefined();
  });

  it("hands the next question nothing, because the first question took the ask", () => {
    const carrier: { workScopeAsk?: typeof ask } = { workScopeAsk: ask };

    consumeWorkScopeAsk(carrier);

    expect(consumeWorkScopeAsk(carrier)).toBeUndefined();
    expect(carrier.workScopeAsk).toBeUndefined();
  });
});
