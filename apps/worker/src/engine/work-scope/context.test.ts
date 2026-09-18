import { describe, expect, it } from "vitest";
import type { WorkScope, WorkScopeActor } from "@shared/contracts";
import {
  commentPathAfterAnUnrecordedAnswer,
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
    answeredRepositoryKeys: [],
    ticketText: null,
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
      "Excluding a repository is not final: this work's repository list can be changed through the work scope API or the work_scope.edit tool, and the next run starts from the changed list.",
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

  it("does not send that person to enable a repository that is already enabled", () => {
    const recorder = createRunWorkScopeRecorder(
      input({
        catalog: {
          activated: true,
          // Unusable keys are a SUBSET of enabled ones, so this sentence is
          // only ever written about a repository that is enabled already.
          // Telling the reader to enable it sends them to a page where they
          // find it switched on, and costs them a round to learn that the
          // repository itself is what has to change.
          enabledKeys: ["github:acme/api", "github:acme/web"],
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

    expect(recorder.recoveryNotes[1]).toContain("cannot serve");
    expect(recorder.recoveryNotes.join(" ")).not.toContain("Repositories page");
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
      "Excluding a repository is not final: this work's repository list can be changed through the work scope API or the work_scope.edit tool, and the next run starts from the changed list.",
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
      "Excluding a repository is not final: this work's repository list can be changed through the work scope API or the work_scope.edit tool, and the next run starts from the changed list.",
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

  // The selection counts with `decidableKeys` and then raises the question with
  // `decide`. If the two ever read "open" differently, the run counts one set
  // and puts a different one in front of a person: a repository they already
  // answered for comes back as a choice, or one still open is left out of the
  // only question they hear. Each case below is where a restated rule drifts
  // first: the expiry conditions, the pin halves, a duplicate key.
  it("counts exactly the repositories the which-of-these question then offers", () => {
    const person = { kind: "person" as const, actorId: "p1", actorLabel: "Ada" };
    const activated = createRunWorkScopeRecorder(
      input({
        catalog: {
          activated: true,
          enabledKeys: [
            "github:acme/api",
            "github:acme/web",
            "github:acme/docs",
            "github:acme/ops",
            "github:acme/lib",
            "gitlab:acme/api",
          ],
          unusableKeys: ["github:acme/ops"],
        },
        repositoryScope: { providers: ["github"], repositories: [] },
        scope: scopeWith([
          excluded("github:acme/docs"),
          // Answered "continue without it" while it was not enabled; enabled
          // since, on an activated catalog, so the answer has expired.
          {
            repositoryKey: "github:acme/lib",
            state: "unavailable",
            unavailableReason: "not_enabled",
            origin: "person",
            rationale: "continue without it",
            decidedBy: person,
            decidedAt: NOW,
          },
          {
            repositoryKey: "github:acme/web",
            state: "selected",
            origin: "trigger_policy",
            rationale: "the trigger's own repository",
            decidedBy: ACTOR,
            decidedAt: NOW,
          },
        ]),
      }),
    );
    const matched = [
      "github:acme/api",
      "github:acme/web",
      "github:acme/docs",
      "github:acme/ops",
      "github:acme/lib",
      "gitlab:acme/api",
      "github:acme/tools",
      "github:acme/api",
    ];
    // api: open. web: a selection nobody made a person's, still open. docs:
    // excluded. ops: unusable. lib: expired, so open again. gitlab: outside the
    // provider pin. tools: not in the catalog. The second api: the same key.
    expect(activated.decidableKeys(matched)).toEqual([
      "github:acme/api",
      "github:acme/web",
      "github:acme/lib",
    ]);
    expect(
      activated.decide({ kind: "text_ambiguous", matchedKeys: matched }).ask.map(
        (asked) => asked.repositoryKey,
      ),
    ).toEqual(["github:acme/api", "github:acme/web", "github:acme/lib"]);

    // A bridge catalog that never listed usability: neither kind of
    // `unavailable` may expire here, because nothing observed the repository
    // becoming available. Expiring either would put the question back in front
    // of the person who already answered it.
    const bridge = createRunWorkScopeRecorder(
      input({
        catalog: {
          activated: false,
          enabledKeys: ["github:acme/api", "github:acme/web", "github:acme/docs", "github:acme/lib"],
          unusableKeys: null,
        },
        scope: scopeWith([
          {
            repositoryKey: "github:acme/docs",
            state: "unavailable",
            unavailableReason: "not_enabled",
            origin: "person",
            rationale: "continue without it",
            decidedBy: person,
            decidedAt: NOW,
          },
          {
            repositoryKey: "github:acme/web",
            state: "unavailable",
            unavailableReason: "unusable",
            origin: "person",
            rationale: "continue without it",
            decidedBy: person,
            decidedAt: NOW,
          },
        ]),
      }),
    );
    const bridgeMatched = ["github:acme/api", "github:acme/web", "github:acme/docs", "github:acme/lib"];
    expect(bridge.decidableKeys(bridgeMatched)).toEqual(["github:acme/api", "github:acme/lib"]);
    expect(
      bridge.decide({ kind: "text_ambiguous", matchedKeys: bridgeMatched }).ask.map(
        (asked) => asked.repositoryKey,
      ),
    ).toEqual(["github:acme/api", "github:acme/lib"]);
  });

  it("bounds a key list at what one event may carry", () => {
    const keys = Array.from({ length: 12 }, (_, index) => `github:acme/repo-${index}`);
    expect(
      createRunWorkScopeRecorder(input()).boundEventKeys(keys),
    ).toHaveLength(8);
  });
});

// Joint gate round 3, R2 (the skeptic's probe P3). The ticket names three open
// repositories and the one the answer left unnamed is not among them. A path
// written for it joins those three, the next run counts four, asks instead of
// taking any, and the repository never arrives. The way back may only offer the
// comment when the count WITH the offered repository stays within three.
describe("the comment route counts the repository it offers", () => {
  const KEYS = ["a", "b", "c", "f", "g"].map((name) => `github:acme/${name}`);
  const recorder = (matchedKeys: string[]) =>
    createRunWorkScopeRecorder(
      input({
        catalog: { activated: true, enabledKeys: KEYS, unusableKeys: [] },
        selectionAnswered: true,
        answeredRepositoryKeys: ["github:acme/f", "github:acme/g"],
        ticketText: {
          matchedKeys,
          datableKeys: ["github:acme/f", "github:acme/g"],
          mentionedAfterAnswerKeys: [],
        },
      }),
    );

  it("offers only the record when the ticket already names three open repositories besides it", () => {
    const record = recorder(["github:acme/a", "github:acme/b", "github:acme/c"]);

    expect(record.commentPathIsTaken(["github:acme/f"])).toBe(false);
  });

  it("offers the comment when the ticket names two besides it", () => {
    const record = recorder(["github:acme/a", "github:acme/b"]);

    expect(record.commentPathIsTaken(["github:acme/f"])).toBe(true);
  });

  // S13: the sentence offers every repository it names at once, so a person who
  // writes both paths in one comment must not tip the next run into asking.
  it("counts every repository it offers together, not one at a time", () => {
    const record = recorder(["github:acme/a", "github:acme/b"]);

    expect(record.commentPathIsTaken(["github:acme/f"])).toBe(true);
    expect(record.commentPathIsTaken(["github:acme/f", "github:acme/g"])).toBe(false);
  });

  it("counts a repository the ticket already names once", () => {
    const record = recorder(["github:acme/a", "github:acme/b", "github:acme/f"]);

    expect(record.commentPathIsTaken(["github:acme/f"])).toBe(true);
  });

  it("says so in the way back a refused request carries", () => {
    const record = recorder(["github:acme/a", "github:acme/b", "github:acme/c"]);

    record.decide({ kind: "requested", repositoryKeys: ["github:acme/f"] });

    expect(record.recoveryNotes.join(" ")).not.toContain("ticket comment");
    expect(record.recoveryNotes.join(" ")).toContain("work_scope.edit");
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

// Joint gate F4. The comment about an answer that recorded nothing runs with no
// run behind it and no scan of the ticket. A route it offers has to be one the
// next run provably takes; the three-repository limit is the one rule 6 of
// docs/product/repository-record-behaviour.md states for the ticket's text.
/**
 * WHICH QUESTION THIS IS, told from the question itself.
 *
 * The two arms that matter are pinned against the REAL builders, not against a
 * copy of their words, because a sentence typed into a test cannot drift and
 * the builder can:
 *
 * - the ticket-text question, in `repo-selection-work-scope.test.ts`, which
 *   feeds this predicate the questions the step actually produced;
 * - the discovery question, in `engine/tests/work-scope-discovery.test.ts`,
 *   which feeds it `repositoryDiscoveryQuestion`'s own output.
 *
 * What is left here is the case no builder writes: arbitrary prose from some
 * other question, which must fall to the safe side.
 */
describe("commentPathAfterAnUnrecordedAnswer", () => {
  it("offers only the record for a question raised mid run", () => {
    expect(
      commentPathAfterAnUnrecordedAnswer({
        questions: ["Should this work also use github:acme/api?"],
      }),
    ).toBe("unproven");
  });
});
