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

function excluded(repositoryKey: string): WorkScope["entries"][number] {
  return {
    repositoryKey,
    state: "excluded",
    origin: "person",
    rationale: "not this one",
    decidedBy: { kind: "person", actorId: "p1", actorLabel: "Ada" },
    decidedAt: NOW,
  };
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

  it("keeps the repository each refusal is about, for the surface that renders a line per repository", () => {
    const recorder = createRunWorkScopeRecorder(
      input({ scope: scopeWith([excluded("github:acme/api")]) }),
    );

    recorder.decide({
      kind: "derived",
      origin: "ticket_text",
      repositoryKeys: ["github:acme/api"],
      rationale: "ticket mentions repository path",
    });
    // A caller's own sentence names no repository, so it stays out of the keyed
    // list and in the flat one.
    recorder.note("The ticket names github:acme/web, and this run could take none of them.");

    // Who excluded it and when, because the mid run expansion refusal says that
    // about the same repository and the two may not disagree on facts. What a
    // person can do about it is not here: it travels `recoveryNotes`, which the
    // model never reads.
    expect(recorder.leftOut).toEqual([
      {
        repositoryKey: "github:acme/api",
        reason:
          "github:acme/api was excluded on this work by Ada on 2026-09-16," +
          " so the run started without it.",
      },
    ]);
    expect(recorder.notes).toHaveLength(2);
  });

  it("tells a person an exclusion can be taken back, once however many it refused, and never through the notes the model may read", () => {
    const recorder = createRunWorkScopeRecorder(
      input({ scope: scopeWith([excluded("github:acme/api"), excluded("github:acme/web")]) }),
    );

    recorder.decide({
      kind: "derived",
      origin: "ticket_text",
      repositoryKeys: ["github:acme/api"],
      rationale: "ticket mentions repository path",
    });
    recorder.decide({
      kind: "derived",
      origin: "inferred",
      repositoryKeys: ["github:acme/web"],
      rationale: "only accessible repository",
    });

    expect(recorder.recoveryNotes).toEqual([
      "Excluding a repository is not final: this work's repository list can be changed, and the next run starts from the changed list.",
    ]);
    // Two refusals, and the sentence for a person is not among them.
    expect(recorder.notes).toHaveLength(2);
    expect(recorder.notes.join(" ")).not.toContain("not final");
  });

  it("adds the second fact when the listing says the repository cannot be used, rather than dropping the first", () => {
    const recorder = createRunWorkScopeRecorder(
      input({
        catalog: {
          activated: true,
          enabledKeys: ["github:acme/api", "github:acme/web"],
          // Enabled, and the catalog holds no default branch for it.
          unusableKeys: ["github:acme/api"],
        },
        scope: scopeWith([excluded("github:acme/api")]),
      }),
    );

    recorder.decide({
      kind: "derived",
      origin: "ticket_text",
      repositoryKeys: ["github:acme/api"],
      rationale: "ticket mentions repository path",
    });

    expect(recorder.notes).toHaveLength(1);
    expect(recorder.recoveryNotes).toHaveLength(2);
    expect(recorder.recoveryNotes[0]).toContain("not final");
    expect(recorder.recoveryNotes[1]).toContain("github:acme/api");
    expect(recorder.recoveryNotes[1]).toContain("cannot serve");
  });

  // The pin is the OTHER thing that outlives an edit to the list. Changing the
  // list is within reach of the person reading the sentence; changing what the
  // workflow definition is pinned to is not, and a run whose pin excludes the
  // repository will refuse it again on the next run however the list reads. So
  // the promise is made the same way the usability one is: made, and then bounded
  // by naming what else stands in the way.
  it("names the pin as well when the workflow this run belongs to is not allowed the repository", () => {
    const recorder = createRunWorkScopeRecorder(
      input({
        repositoryScope: { providers: [], repositories: [{ provider: "github", repoPath: "acme/web" }] },
        scope: scopeWith([excluded("github:acme/api")]),
      }),
    );

    recorder.decide({
      kind: "derived",
      origin: "ticket_text",
      repositoryKeys: ["github:acme/api"],
      rationale: "ticket mentions repository path",
    });

    expect(recorder.notes).toHaveLength(1);
    expect(recorder.recoveryNotes).toHaveLength(2);
    expect(recorder.recoveryNotes[0]).toContain("not final");
    expect(recorder.recoveryNotes[1]).toBe(
      "The workflow that runs this work is limited to a fixed set of repositories," +
        " which does not include github:acme/api, so changing the list brings that repository" +
        " back only once that limit changes.",
    );
  });

  it("names the pin when it is the provider that is not allowed, not only the repository", () => {
    const recorder = createRunWorkScopeRecorder(
      input({
        catalog: {
          activated: true,
          enabledKeys: ["github:acme/api", "gitlab:group/api"],
          unusableKeys: [],
        },
        repositoryScope: { providers: ["github"], repositories: [] },
        scope: scopeWith([excluded("gitlab:group/api")]),
      }),
    );

    recorder.decide({
      kind: "derived",
      origin: "ticket_text",
      repositoryKeys: ["gitlab:group/api"],
      rationale: "ticket mentions repository path",
    });

    expect(recorder.recoveryNotes).toHaveLength(2);
    expect(recorder.recoveryNotes[1]).toContain("gitlab:group/api");
    expect(recorder.recoveryNotes[1]).toContain("limited to a fixed set of repositories");
  });

  it("says nothing about a pin that already allows the repository, because nothing else stands in the way", () => {
    const recorder = createRunWorkScopeRecorder(
      input({
        repositoryScope: {
          providers: ["github"],
          repositories: [{ provider: "github", repoPath: "acme/api" }],
        },
        scope: scopeWith([excluded("github:acme/api")]),
      }),
    );

    recorder.decide({
      kind: "derived",
      origin: "ticket_text",
      repositoryKeys: ["github:acme/api"],
      rationale: "ticket mentions repository path",
    });

    expect(recorder.recoveryNotes).toEqual([
      "Excluding a repository is not final: this work's repository list can be changed, and the next run starts from the changed list.",
    ]);
  });

  // No production path builds a recorder without a listing: all three callers
  // (`pre-sandbox/steps/repo-selection.ts`, `engine/agent-workflow.ts`,
  // `engine/steps/phase.ts`) hand it a real catalog listing, and the two places
  // that pass `unusableKeys: null` (`services/work-scope/record.ts`,
  // `services/clarifications/answer-core.ts`) call `decideWorkScope` directly
  // and build no sentences at all. The combination is reachable through the
  // type, so this pins the intent for the day a fourth caller appears: the
  // recovery sentence promises only that the LIST can be changed and that the
  // next run starts from the changed list, which is true whether or not anybody
  // listed the repositories. What a listing buys is the SECOND sentence, and a
  // caller holding no listing owes silence on that one alone.
  it("says only the recovery sentence on a path that listed no repositories at all", () => {
    const recorder = createRunWorkScopeRecorder(
      input({
        catalog: {
          activated: true,
          enabledKeys: ["github:acme/api", "github:acme/web"],
          unusableKeys: null,
        },
        scope: scopeWith([excluded("github:acme/api")]),
      }),
    );

    recorder.decide({
      kind: "derived",
      origin: "ticket_text",
      repositoryKeys: ["github:acme/api"],
      rationale: "ticket mentions repository path",
    });

    expect(recorder.notes).toHaveLength(1);
    expect(recorder.recoveryNotes).toEqual([
      "Excluding a repository is not final: this work's repository list can be changed, and the next run starts from the changed list.",
    ]);
  });

  it("says nothing about a repository the catalog no longer holds, because changing the list cannot bring it back", () => {
    const recorder = createRunWorkScopeRecorder(
      input({
        catalog: {
          activated: true,
          enabledKeys: ["github:acme/web"],
          unusableKeys: [],
        },
        scope: scopeWith([excluded("github:acme/api")]),
      }),
    );

    recorder.decide({
      kind: "derived",
      origin: "ticket_text",
      repositoryKeys: ["github:acme/api"],
      rationale: "ticket mentions repository path",
    });

    expect(recorder.notes).toHaveLength(1);
    expect(recorder.recoveryNotes).toEqual([]);
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
