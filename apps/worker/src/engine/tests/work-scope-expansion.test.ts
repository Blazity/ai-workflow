import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * The in-run expansion loop, seen from the record.
 *
 * When the model asks for another repository, the record answers first: one it
 * already holds as excluded or unavailable is refused without troubling
 * anybody, one outside the trigger policy is asked about at most once per
 * subject, and every guard rail of the protocol refuses the MODEL rather than
 * putting a question nobody could answer usefully.
 *
 * The loop in `agent-workflow.ts` is an inline closure, so these drive the
 * exported seams it is built from, the way `multi-repo-research.test.ts` drives
 * the expansion state: the validator decides the verdict against the record,
 * `decideRepositoryExpansion` decides the action and the next state, and
 * `applyHumanRepositoryExpansion` decides what a resumed run attaches.
 */
import type {
  TriggerRepositoryPolicy,
  WorkScope,
  WorkScopeEntry,
  WorkScopeTrailEvent,
} from "@shared/contracts";
import type { RepositoryCatalogEntry } from "../repository-discovery/catalog.js";
import {
  decideRepositoryExpansion,
  offerableRepositoryCatalog,
  repositoryExpansionPlans,
  repositoryExpansionRefusalPlan,
  repositoryExpansionRefusalSentence,
  validateRepositoryExpansionRequests,
} from "../repository-discovery/runner.js";
import { appendRunClarificationRound, createRepositoryQuestions } from "../agent-workflow.js";
import { applyHumanRepositoryExpansion } from "../steps/phase.js";
import {
  consumeWorkScopeAsk,
  createRunWorkScopeRecorder,
  type TicketTextReading,
} from "../work-scope/context.js";
import {
  buildResearchAnalysisReport,
  formatPublishedAnalysisComment,
  withAnalysisPublication,
} from "../support/run-analysis-report.js";
import type { EngineCtx } from "../blocks/support/types.js";
import { makeCtx } from "../blocks/support/test-support.js";

const SUBJECT = "ticket:jira:AWT-1";
const NOW = "2026-09-15T12:00:00.000Z";

const RUN_ACTOR = {
  kind: "run" as const,
  runId: "run-7",
  definitionId: 1,
  definitionVersion: 4,
};

const PERSON_ACTOR = {
  kind: "person" as const,
  actorId: "u-1",
  actorLabel: "Ada Lovelace",
};

const ANY_CATALOG: TriggerRepositoryPolicy = {
  candidates: { kind: "enabled_catalog" },
  expansion: "ask_once",
};

function catalogEntry(
  provider: "github" | "gitlab",
  repoPath: string,
  usable = true,
): RepositoryCatalogEntry {
  return {
    provider,
    repoPath,
    name: repoPath.split("/").at(-1) ?? repoPath,
    defaultBranch: usable ? "main" : "",
    description: "",
    topics: [],
    relationships: [],
    usable,
    ...(usable ? {} : { unusableReason: "missing_default_branch" as const }),
  };
}

function entry(
  repositoryKey: string,
  state: WorkScopeEntry["state"],
  extra: Partial<WorkScopeEntry> = {},
): WorkScopeEntry {
  return {
    repositoryKey,
    state,
    origin: "person",
    rationale: "a person decided it on this ticket",
    decidedBy: PERSON_ACTOR,
    decidedAt: "2026-09-10T08:30:00.000Z",
    ...extra,
  };
}

function scopeOf(...entries: WorkScopeEntry[]): WorkScope {
  return { subjectKey: SUBJECT, version: entries.length + 1, entries };
}

function repository(provider: "github" | "gitlab", repoPath: string) {
  return { provider, repoPath, defaultBranch: "main", selectedRationale: "attached" };
}

/** The recorder the expansion closure builds, and the adapter it hands the
 *  validator. One per test, so the plans a test reads are its own. */
function recorderFor(input: {
  scope: WorkScope | null;
  catalog: RepositoryCatalogEntry[];
  attached?: Array<{ provider: "github" | "gitlab"; repoPath: string }>;
  policy?: TriggerRepositoryPolicy;
  activated?: boolean;
  answeredRepositoryKeys?: string[];
  /** The pre-sandbox's reading of the ticket. By default a ticket naming
   *  nothing, read by a run that can date a comment against every answer. */
  ticketText?: TicketTextReading | null;
}) {
  return createRunWorkScopeRecorder({
    subjectKey: SUBJECT,
    scope: input.scope,
    selectionAnswered: false,
    answeredRepositoryKeys: input.answeredRepositoryKeys ?? [],
    ticketText:
      input.ticketText === undefined
        ? {
            matchedKeys: [],
            datableKeys: input.answeredRepositoryKeys ?? [],
            mentionedAfterAnswerKeys: [],
          }
        : input.ticketText,
    catalog: {
      activated: input.activated ?? true,
      enabledKeys: input.catalog.map((repo) => `${repo.provider}:${repo.repoPath}`),
      unusableKeys: input.catalog
        .filter((repo) => !repo.usable)
        .map((repo) => `${repo.provider}:${repo.repoPath}`),
    },
    policy: input.policy ?? ANY_CATALOG,
    actor: RUN_ACTOR,
    now: NOW,
    attachedKeys: (input.attached ?? []).map((repo) => `${repo.provider}:${repo.repoPath}`),
  });
}

function requestFor(provider: "github" | "gitlab", repoPath: string) {
  return { provider, repoPath, rationale: "research needs it" };
}

/** Everything the closure hands the validator, with the record wired in. */
function validateAgainstRecord(input: {
  requests: Array<ReturnType<typeof requestFor>>;
  catalog: RepositoryCatalogEntry[];
  attached?: Array<{ provider: "github" | "gitlab"; repoPath: string }>;
  record: ReturnType<typeof recorderFor>;
  completedRounds?: number;
}) {
  return validateRepositoryExpansionRequests({
    requests: input.requests,
    catalog: input.catalog,
    attached: input.attached ?? [],
    completedRounds: input.completedRounds ?? 0,
    workScope: {
      decideRequested: (repositoryKeys) =>
        input.record.decide({ kind: "requested", repositoryKeys }),
    },
  });
}

function trailOf(record: ReturnType<typeof recorderFor>): WorkScopeTrailEvent[] {
  return record.plans.flatMap((plan) => plan.trail);
}

describe("the record answers an expansion request before the catalog does", () => {
  it("refuses a repository recorded as unavailable without asking anybody again", () => {
    const catalog = [catalogEntry("github", "acme/web")];
    const record = recorderFor({
      scope: scopeOf(
        entry("github:acme/api", "unavailable", { unavailableReason: "not_enabled" }),
      ),
      catalog,
      attached: [{ provider: "github", repoPath: "acme/web" }],
    });

    const verdict = validateAgainstRecord({
      requests: [requestFor("github", "acme/api")],
      catalog,
      attached: [{ provider: "github", repoPath: "acme/web" }],
      record,
    });

    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(verdict.refusals).toEqual([
      { repositoryKey: "github:acme/api", reason: "unavailable" },
    ]);
    expect(verdict.repositories).toEqual([]);
    expect(trailOf(record)).toEqual([
      { kind: "request_refused", repositoryKey: "github:acme/api", reason: "unavailable" },
    ]);
  });

  it("attaches the same repository once the catalog enables it, still without a question", () => {
    // The person said "continue without it" because the run could not have it.
    // Enabling it is the change that answer was waiting for, so the request is
    // honoured rather than put to them a second time.
    const catalog = [catalogEntry("github", "acme/web"), catalogEntry("github", "acme/api")];
    const record = recorderFor({
      scope: scopeOf(
        entry("github:acme/api", "unavailable", { unavailableReason: "not_enabled" }),
      ),
      catalog,
      attached: [{ provider: "github", repoPath: "acme/web" }],
    });

    const verdict = validateAgainstRecord({
      requests: [requestFor("github", "acme/api")],
      catalog,
      attached: [{ provider: "github", repoPath: "acme/web" }],
      record,
    });

    expect(verdict.kind).toBe("attach");
    if (verdict.kind !== "attach") return;
    expect(verdict.repositories.map((repo) => `${repo.provider}:${repo.repoPath}`)).toEqual([
      "github:acme/api",
    ]);
    expect(trailOf(record).map((event) => event.kind)).toEqual(["entry_written"]);
  });

  it("names who declined an excluded repository, and when, in the refusal the model reads", () => {
    const catalog = [catalogEntry("github", "acme/web"), catalogEntry("github", "acme/api")];
    const record = recorderFor({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      catalog,
      attached: [{ provider: "github", repoPath: "acme/web" }],
    });

    const verdict = validateAgainstRecord({
      requests: [requestFor("github", "acme/api")],
      catalog,
      attached: [{ provider: "github", repoPath: "acme/web" }],
      record,
    });

    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(verdict.refusals).toEqual([
      { repositoryKey: "github:acme/api", reason: "excluded" },
    ]);
    const sentence = repositoryExpansionRefusalSentence(verdict.refusals[0], {
      decidedBy: PERSON_ACTOR,
      decidedAt: "2026-09-10T08:30:00.000Z",
    });
    expect(sentence).toContain("github:acme/api");
    expect(sentence).toContain("Ada Lovelace");
    // The DAY, not the instant. This sentence is read by the model and by a
    // person in a ticket comment; a timestamp to the millisecond is precision
    // neither can act on, and it invites a reader to reason about an hour
    // nobody told them the timezone of.
    expect(sentence).toContain("on 2026-09-10,");
    expect(sentence).not.toContain("T08:30:00");
  });
});

describe("a repository outside the trigger policy is asked about once per subject", () => {
  const listed: TriggerRepositoryPolicy = {
    candidates: { kind: "listed", repositoryKeys: ["github:acme/web"] },
    expansion: "ask_once",
  };
  const catalog = [catalogEntry("github", "acme/web"), catalogEntry("github", "acme/api")];
  const attached = [{ provider: "github" as const, repoPath: "acme/web" }];

  it("raises exactly one question carrying the repository and the reason it was asked", () => {
    const record = recorderFor({ scope: null, catalog, attached, policy: listed });

    const verdict = validateAgainstRecord({
      requests: [requestFor("github", "acme/api")],
      catalog,
      attached,
      record,
    });

    expect(verdict.kind).toBe("clarification_needed");
    if (verdict.kind !== "clarification_needed") return;
    expect(verdict.questions).toHaveLength(1);
    expect(verdict.workScopeAsk).toEqual([
      { repositoryKey: "github:acme/api", askedBecause: "outside_policy" },
    ]);
    // Named by its full key, because the answer is read back against that key.
    expect(verdict.questions[0]).toContain("github:acme/api");
    // A29: declining keeps it off THIS ticket, never off the workflow.
    expect(verdict.questions[0]).toContain("this ticket");
    expect(record.ask).toEqual([
      { repositoryKey: "github:acme/api", askedBecause: "outside_policy" },
    ]);
  });

  it("asks nothing on a later run, because the answer is on the record", () => {
    // What the answer path wrote when the person declined it.
    const record = recorderFor({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      catalog,
      attached,
      policy: listed,
    });

    const verdict = validateAgainstRecord({
      requests: [requestFor("github", "acme/api")],
      catalog,
      attached,
      record,
    });

    expect(verdict.kind).toBe("refused");
    expect(record.ask).toEqual([]);
  });
});

describe("every guard rail of the expansion protocol refuses the model", () => {
  const catalog = [
    catalogEntry("github", "acme/web"),
    catalogEntry("github", "acme/api"),
    catalogEntry("github", "acme/jobs"),
    catalogEntry("github", "acme/docs"),
    catalogEntry("github", "acme/infra"),
  ];

  it("refuses the round limit instead of raising the expansion-limit question", () => {
    const record = recorderFor({ scope: null, catalog });

    const verdict = validateAgainstRecord({
      requests: [requestFor("github", "acme/api")],
      catalog,
      record,
      completedRounds: 2,
    });

    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(verdict.refusals).toEqual([
      { repositoryKey: "github:acme/api", reason: "rounds_exhausted" },
    ]);
    // The record knows nothing about rounds, so it plans nothing here and the
    // caller appends the line instead.
    expect(trailOf(record)).toEqual([]);
    expect(repositoryExpansionRefusalPlan(verdict.refusals)).toEqual({
      upserts: [],
      deletes: [],
      trail: [
        { kind: "request_refused", repositoryKey: "github:acme/api", reason: "rounds_exhausted" },
      ],
    });
  });

  it("refuses the fourth repository of one request instead of asking which three are essential", () => {
    const attached = [
      { provider: "github" as const, repoPath: "acme/web" },
      { provider: "github" as const, repoPath: "acme/api" },
      { provider: "github" as const, repoPath: "acme/jobs" },
    ];
    const record = recorderFor({ scope: null, catalog, attached });

    const verdict = validateAgainstRecord({
      requests: [
        requestFor("github", "acme/web"),
        requestFor("github", "acme/api"),
        requestFor("github", "acme/jobs"),
        requestFor("github", "acme/docs"),
      ],
      catalog,
      attached,
      record,
    });

    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(verdict.refusals).toEqual([
      { repositoryKey: "github:acme/docs", reason: "request_limit" },
    ]);
    expect(trailOf(record)).toEqual([
      { kind: "request_refused", repositoryKey: "github:acme/docs", reason: "request_limit" },
    ]);
  });

  it("appends one line for a repository requested twice in one round, not two", () => {
    // The refusal vocabulary has no reason for a repeat, so two identical lines
    // would read as an agent that asked twice.
    const record = recorderFor({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      catalog,
    });

    const verdict = validateAgainstRecord({
      requests: [requestFor("github", "acme/api"), requestFor("github", "acme/api")],
      catalog,
      record,
    });

    expect(verdict.kind).toBe("refused");
    expect(trailOf(record)).toEqual([
      { kind: "request_refused", repositoryKey: "github:acme/api", reason: "excluded" },
    ]);
  });

  it("refuses a repository that would not fit the workspace instead of asking which are essential", () => {
    const attached = Array.from({ length: 8 }, (_, index) => ({
      provider: "github" as const,
      repoPath: `acme/held-${index}`,
    }));
    const full = [...catalog, ...attached.map((repo) => catalogEntry(repo.provider, repo.repoPath))];
    const record = recorderFor({ scope: null, catalog: full, attached });

    const verdict = validateAgainstRecord({
      requests: [requestFor("github", "acme/api")],
      catalog: full,
      attached,
      record,
    });

    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(verdict.refusals).toEqual([
      { repositoryKey: "github:acme/api", reason: "workspace_cap" },
    ]);
    expect(trailOf(record)).toEqual([
      { kind: "request_refused", repositoryKey: "github:acme/api", reason: "workspace_cap" },
    ]);
  });

  it("plans no entry for a repository it drops to ask about another", () => {
    // The model asked for one repository it can have and one nobody knows. The
    // record decides the whole request in one call, so it counted the first as
    // attached before the question about the second dropped it: the run parks,
    // clones nothing, and the entry would say this work touches a repository
    // the run never took (A44).
    const attached = [{ provider: "github" as const, repoPath: "acme/web" }];
    const record = recorderFor({ scope: null, catalog, attached });

    const verdict = validateAgainstRecord({
      requests: [requestFor("github", "acme/api"), requestFor("github", "acme/unknown")],
      catalog,
      attached,
      record,
    });

    expect(verdict.kind).toBe("clarification_needed");
    if (verdict.kind !== "clarification_needed") return;
    expect(verdict.workScopeAsk).toEqual([
      { repositoryKey: "github:acme/unknown", askedBecause: "not_enabled" },
    ]);
    // The decision did plan the attach it then dropped, which is why the caller
    // may not write what the record planned without asking the verdict first.
    expect(record.plans.flatMap((plan) => plan.upserts)).toHaveLength(1);
    const written = repositoryExpansionPlans(verdict, record.plans);
    expect(written.flatMap((plan) => plan.upserts)).toEqual([]);
    expect(written.flatMap((plan) => plan.trail)).toEqual([]);
  });

  it("keeps the entries of a request it honoured beside the refusals", () => {
    // The other half of the same rule: a verdict that DOES carry repositories
    // writes their entries, so dropping the plan wholesale would lose an attach
    // the run really made.
    const record = recorderFor({
      scope: scopeOf(entry("github:acme/jobs", "excluded")),
      catalog,
      attached: [{ provider: "github", repoPath: "acme/web" }],
    });

    const verdict = validateAgainstRecord({
      requests: [requestFor("github", "acme/api"), requestFor("github", "acme/jobs")],
      catalog,
      attached: [{ provider: "github", repoPath: "acme/web" }],
      record,
    });

    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;
    expect(verdict.repositories.map((repo) => repo.repoPath)).toEqual(["acme/api"]);
    const written = repositoryExpansionPlans(verdict, record.plans);
    expect(written.flatMap((plan) => plan.upserts).map((upsert) => upsert.entry.repositoryKey)).toEqual([
      "github:acme/api",
    ]);
  });

  it("carries a refusal on to research rather than parking the run, and closes the rounds it used up", () => {
    const record = recorderFor({ scope: null, catalog });
    const requests = [requestFor("github", "acme/api")];
    const verdict = validateAgainstRecord({
      requests,
      catalog,
      record,
      completedRounds: 2,
    });

    const { action, state } = decideRepositoryExpansion({
      origin: "model",
      verdict,
      state: { rounds: 2, priorRequests: [] },
      requests,
    });

    expect(action.kind).toBe("proceed");
    // Nobody can answer a refusal, so the model is told expansion is over
    // rather than being left to request the same repository every pass.
    expect(state.expansionClosed).toBe("bound");
  });
});

describe("an expansion request for a repository an answer left unnamed", () => {
  // Skeptic 8. A which-of-these question named acme/api, the answer named none,
  // and research then asks for acme/api. Attaching takes the omission back,
  // asking puts an answered question to the same person again. It is refused
  // with its own reason, the run carries on, and the person reads why and how to
  // take it back.
  it("refuses it with its own reason, carries on, and tells the model and the person apart from an exclusion", () => {
    const catalog = [catalogEntry("github", "acme/web"), catalogEntry("github", "acme/api")];
    const record = recorderFor({
      scope: null,
      catalog,
      attached: [{ provider: "github", repoPath: "acme/web" }],
      answeredRepositoryKeys: ["github:acme/api"],
    });
    const requests = [requestFor("github", "acme/api")];
    const verdict = validateAgainstRecord({
      requests,
      catalog,
      attached: [{ provider: "github", repoPath: "acme/web" }],
      record,
    });

    expect(verdict).toEqual({
      kind: "refused",
      refusals: [{ repositoryKey: "github:acme/api", reason: "unnamed_in_answer" }],
      repositories: [],
    });
    const { action } = decideRepositoryExpansion({
      origin: "model",
      verdict,
      state: { rounds: 0, priorRequests: [] },
      requests,
    });
    expect(action.kind).toBe("proceed");

    // The model's sentence says what happened and nothing an exclusion says.
    if (verdict.kind !== "refused") throw new Error("expected a refusal");
    const [refusal] = verdict.refusals;
    if (!refusal) throw new Error("expected one refusal");
    expect(repositoryExpansionRefusalSentence(refusal)).toBe(
      "github:acme/api was listed in a repository question already answered on this work" +
        " and is not selected on it, so it is not attached.",
    );
    // One trail line, as every expansion refusal has.
    expect(trailOf(record)).toEqual([
      { kind: "request_refused", repositoryKey: "github:acme/api", reason: "unnamed_in_answer" },
    ]);
    // The person's channel: the way back, both doors, because the one question
    // on this work named a single repository.
    expect(record.recoveryNotes).toEqual([
      "Leaving a repository out of an answer is not final: this work's repository list can be" +
        " changed through the work scope API or the work_scope.edit tool, or the repository's full" +
        " path can be written in a ticket comment, as github:acme/api, and the next run reads both.",
    ]);
  });
});

describe("what a person reads about a mid-run refusal", () => {
  /** Enough of a usage snapshot for the report builder; nothing here reads it. */
  const USAGE = {
    costUsd: 0,
    costKnown: false,
    tokensInput: null,
    tokensCached: null,
    tokensOutput: null,
    phases: {
      research: { costUsd: null, tokens: null, durationMs: 1, numTurns: 1, model: "gpt-5.6" },
    },
  };

  // The run carries on, so no halt text reaches anybody and the prompt addition
  // reaches the model alone. The comment a finished run posts is the only
  // surface left, and what the person needs from it is all three things: which
  // repository, that their own answer is why, and what to do if they want it
  // after all. Driven from the refusal the record actually decided, through the
  // real report builder and the real comment formatter.
  it("names the repository, says the answer did not name it, and gives the way back", () => {
    const catalog = [catalogEntry("github", "acme/web"), catalogEntry("github", "acme/api")];
    const record = recorderFor({
      scope: null,
      catalog,
      attached: [{ provider: "github", repoPath: "acme/web" }],
      answeredRepositoryKeys: ["github:acme/api"],
      ticketText: {
        matchedKeys: ["github:acme/api"],
        datableKeys: ["github:acme/api"],
        mentionedAfterAnswerKeys: [],
      },
    });
    const verdict = validateAgainstRecord({
      requests: [requestFor("github", "acme/api")],
      catalog,
      attached: [{ provider: "github", repoPath: "acme/web" }],
      record,
    });
    if (verdict.kind !== "refused") throw new Error("expected a refusal");
    const [refusal] = verdict.refusals;
    if (!refusal) throw new Error("expected one refusal");

    const report = withAnalysisPublication(
      buildResearchAnalysisReport({
        runId: "expansion-refusal",
        workspaceManifest: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/web",
              defaultBranch: "main",
              branchName: "arthur/AWT-1",
              researchBaseSha: "abcdef123456",
              access: "write",
            },
          ],
        },
        // Exactly what `agent-workflow.ts` concatenates for a refused request,
        // and the notes the same recorder composed.
        leftOutRepositories: [
          {
            repositoryKey: refusal.repositoryKey,
            reason: repositoryExpansionRefusalSentence(refusal),
          },
        ],
        repositoryRecoveryNotes: [...record.recoveryNotes],
        researchResult: { body: "Plan" },
        usage: USAGE,
      }),
      [{ provider: "github", repoPath: "acme/web", id: 1, url: "https://github.com/acme/web/pull/1" }],
      "Implemented",
      USAGE,
    );

    const comment = formatPublishedAnalysisComment(report, "https://dashboard.example/runs/x");
    const repositories = comment
      .split("\n\n")
      .find((section) => section.startsWith("Repositories"));

    expect(repositories).toContain(
      "- github:acme/api · left out · github:acme/api was listed in a repository question" +
        " already answered on this work and is not selected on it, so it is not attached.",
    );
    expect(repositories).toContain(
      "Leaving a repository out of an answer is not final: this work's repository list can be" +
        " changed through the work scope API or the work_scope.edit tool, or the repository's" +
        " full path can be written in a ticket comment, as github:acme/api, and the next run" +
        " reads both.",
    );
  });
});

describe("an expansion question carries the repositories it asked about", () => {
  const listed: TriggerRepositoryPolicy = {
    candidates: { kind: "listed", repositoryKeys: ["github:acme/web"] },
    expansion: "ask_once",
  };
  const catalog = [
    catalogEntry("github", "acme/web"),
    catalogEntry("github", "acme/api"),
    catalogEntry("github", "acme/jobs"),
  ];
  const attached = [{ provider: "github" as const, repoPath: "acme/web" }];

  /** One expansion pass, as the run makes it: a recorder of its own, the
   *  verdict, and the question raised through the one door. What comes back is
   *  what the clarification row would carry. */
  function askThrough(
    questions: ReturnType<typeof createRepositoryQuestions>,
    ctx: EngineCtx,
    request: ReturnType<typeof requestFor>,
  ) {
    const record = recorderFor({ scope: null, catalog, attached, policy: listed });
    const verdict = validateAgainstRecord({
      requests: [request],
      catalog,
      attached,
      record,
    });
    expect(verdict.kind).toBe("clarification_needed");
    questions.raise(
      verdict.kind === "clarification_needed" ? verdict.questions : [],
      verdict.kind === "clarification_needed" && verdict.workScopeAsk
        ? { subjectKey: record.subjectKey, askedRepositories: verdict.workScopeAsk }
        : null,
    );
    // The park chain TAKES the field, which is how a later question cannot
    // inherit this one's repositories.
    return consumeWorkScopeAsk(ctx);
  }

  it("gives a second question in the same run its own repositories, never the first one's", () => {
    // A fresh recorder per pass is how the run works, so the cumulative ask of
    // one recorder proves nothing; what the second clarification row carries
    // does.
    const ctx = makeCtx();
    const questions = createRepositoryQuestions(ctx);

    const first = askThrough(questions, ctx, requestFor("github", "acme/api"));
    const second = askThrough(questions, ctx, requestFor("github", "acme/jobs"));

    expect(first).toEqual({
      subjectKey: SUBJECT,
      askedRepositories: [
        { repositoryKey: "github:acme/api", askedBecause: "outside_policy" },
      ],
    });
    expect(second).toEqual({
      subjectKey: SUBJECT,
      askedRepositories: [
        { repositoryKey: "github:acme/jobs", askedBecause: "outside_policy" },
      ],
    });
  });

  it("repeats a question this run could not read an answer to with the repositories it asked about", () => {
    // The second answer must be able to settle what the first one did not: a
    // follow-up naming no repository has its answer dropped as well, and the
    // next run asks the same person the same thing a third time (A41).
    const ctx = makeCtx();
    const questions = createRepositoryQuestions(ctx);
    const asked = askThrough(questions, ctx, requestFor("github", "acme/api"));

    const followUp = questions.repeat([
      "Repository expansion: that answer named no repository this run can use.",
    ]);

    expect(followUp.kind).toBe("needs_human_input");
    expect(ctx.workScopeAsk).toEqual(asked);
  });

  it("carries nothing on a question raised by a run that froze no record", () => {
    const ctx = makeCtx();
    const questions = createRepositoryQuestions(ctx);

    questions.raise(["Repository expansion: which repository should this run add?"], null);
    expect(ctx.workScopeAsk).toBeUndefined();
    // And the follow-up invents nothing either: there is no record to write an
    // answer to, which is what every run did before the record existed.
    questions.repeat(["Repository expansion: say it again"]);
    expect(ctx.workScopeAsk).toBeUndefined();
  });
});

describe("discovery offers the model only what the record allows", () => {
  it("does not offer a repository a person excluded on this work", () => {
    const catalog = [catalogEntry("github", "acme/api"), catalogEntry("github", "acme/web")];
    const record = recorderFor({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      catalog,
    });

    const offered = offerableRepositoryCatalog(catalog, record);

    // Left out, and nothing said about it: a list the model may not ask for is
    // only noise, and picking it would spend a round on a decision already made.
    expect(offered.map((repo) => `${repo.provider}:${repo.repoPath}`)).toEqual([
      "github:acme/web",
    ]);
    expect(JSON.stringify(offered)).not.toContain("acme/api");
  });

  it("still offers a repository the catalog cannot use, which the record never decided", () => {
    const catalog = [
      catalogEntry("github", "acme/api", false),
      catalogEntry("github", "acme/web"),
    ];
    const record = recorderFor({ scope: null, catalog });

    expect(
      offerableRepositoryCatalog(catalog, record).map(
        (repo) => `${repo.provider}:${repo.repoPath}`,
      ),
    ).toEqual(["github:acme/api", "github:acme/web"]);
  });

  it("offers the whole catalog on a run that froze no record", () => {
    const catalog = [catalogEntry("github", "acme/api"), catalogEntry("github", "acme/web")];

    expect(offerableRepositoryCatalog(catalog, null)).toBe(catalog);
  });
});

describe("a resumed run reads the record, never the answer text", () => {
  const v2Manifest = { version: 2 as const, repositories: [] };

  /** `makeCtx` runs as `run-1`, so a round carrying that id is this run's own
   *  question and anything else is a round some earlier run asked. */
  function resumedCtx(
    answer: string,
    options: { askedBy?: string | null; workScope?: EngineCtx["workScope"] } = {},
  ) {
    const askedBy = options.askedBy === undefined ? "run-1" : options.askedBy;
    return makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: v2Manifest,
      selectedRepositories: [repository("github", "acme/web")],
      clarifications: [
        Object.assign(
          {
            questions: ["Repository expansion: which repository should this run add?"],
            answer,
          },
          askedBy === null ? {} : { runId: askedBy },
        ),
      ],
      ...(options.workScope ? { workScope: options.workScope } : {}),
    });
  }

  it("attaches what the recorded answer chose even when the reply is a bare yes", () => {
    // The answer path read "yes" against the one repository the question named
    // and wrote the entry. The in-run parser cannot read it, so a resumed run
    // that trusted the text would ask the same person the same thing again.
    const ctx = resumedCtx("yes please");
    const attach = vi.fn(async () => ({ manifest: v2Manifest, cloneDurationMs: 3 }));

    return applyHumanRepositoryExpansion(ctx, {
      resolve: async () => ({
        decision: { kind: "unrecognised_answer", questions: ["say it again"] },
        workScope: { repositories: [repository("github", "acme/api")] },
      }),
      attach,
      fetchContexts: async (repositories) =>
        repositories.map((repo) => ({
          repository: repo,
          prComments: [],
          checkResults: [],
          hasConflicts: false,
        })),
    }).then((result) => {
      expect(result.kind).toBe("attached");
      expect(attach).toHaveBeenCalledOnce();
      expect(ctx.selectedRepositories.map((repo) => repo.repoPath)).toEqual([
        "acme/web",
        "acme/api",
      ]);
    });
  });

  /** The contexts the resumed pass hands back once the answer has been used:
   *  the record has nothing left to offer, because what it held is attached. */
  const nothingLeftToAttach = {
    unreadable: {
      decision: { kind: "unrecognised_answer" as const, questions: ["say it again"] },
      workScope: { repositories: [] },
    },
    unusable: {
      decision: {
        kind: "clarification_needed" as const,
        questions: ["Repository expansion: github:acme/db has no default branch."],
        unavailable: [{ provider: "github" as const, repoPath: "acme/db" }],
      },
      workScope: { repositories: [] },
    },
    /** The text parser reading a repository out of the same sentence the record
     *  already used. A45 turns this into an unreadable answer; the guard that
     *  keeps a consumed answer silent has to run on THAT, not on the attach. */
    wouldAttach: {
      decision: {
        kind: "attach" as const,
        repositories: [repository("github", "acme/db")],
      },
      workScope: { repositories: [] },
    },
  };

  async function attachThenPassAgain(second: { decision: unknown; workScope: unknown }) {
    const ctx = resumedCtx("yes please");
    const attach = vi.fn(async () => ({ manifest: v2Manifest, cloneDurationMs: 3 }));
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        decision: { kind: "unrecognised_answer", questions: ["say it again"] },
        workScope: { repositories: [repository("github", "acme/api")] },
      })
      .mockResolvedValue(second);
    const deps = {
      resolve,
      attach,
      fetchContexts: async (repositories: ReturnType<typeof repository>[]) =>
        repositories.map((repo) => ({
          repository: repo,
          prComments: [],
          checkResults: [],
          hasConflicts: false,
        })),
    };
    const first = await applyHumanRepositoryExpansion(ctx, deps);
    // What the planning block does after an attach: `continue`, which runs this
    // same pass again on the same latest round.
    const again = await applyHumanRepositoryExpansion(ctx, deps);
    return { ctx, first, again, attach };
  }

  it("asks nothing further of the person whose answer it just attached", async () => {
    // The record answered "yes please" when it arrived and this pass attached
    // what it chose. By the next pass the record has nothing left to hand back,
    // so all that remains is the sentence, which the text parser cannot read.
    // Asking about it would put a question to somebody seconds after they
    // approved, about a repository already cloned, and their reply to THAT
    // question would be recorded against the repositories the first one asked
    // about, overwriting the decision they had just made.
    const { first, again, attach, ctx } = await attachThenPassAgain(
      nothingLeftToAttach.unreadable,
    );

    expect(first.kind).toBe("attached");
    expect(again.kind).toBe("noop");
    expect(attach).toHaveBeenCalledOnce();
    // Nor is the consumed answer allowed to spend one of the two unreadable
    // answers that close expansion: the person answered perfectly well.
    expect(ctx.repositoryExpansion.unrecognisedAnswers).toBeUndefined();
    expect(ctx.repositoryExpansion.expansionClosed).toBeUndefined();
  });

  it("asks nothing further about a repository the same answer named and the run cannot use", async () => {
    // The other question the pass after an attach can raise: the answer named a
    // second repository that cannot be attached. That was recorded when the
    // answer arrived too, so re-asking is the same repeated question with the
    // same overwriting reply behind it.
    const { first, again, ctx } = await attachThenPassAgain(nothingLeftToAttach.unusable);

    expect(first.kind).toBe("attached");
    expect(again.kind).toBe("noop");
    expect(ctx.repositoryExpansion.unrecognisedAnswers).toBeUndefined();
  });

  it("stays silent after an attach even when the text parser would attach again", async () => {
    // The substitution A45 makes turns that reading into an unreadable answer,
    // and the already-attached guard runs on the decision AFTER it, so the
    // person who approved seconds ago is still asked nothing and still burns
    // none of the two unreadable answers.
    const { first, again, ctx } = await attachThenPassAgain(nothingLeftToAttach.wouldAttach);

    expect(first.kind).toBe("attached");
    expect(again.kind).toBe("noop");
    expect(ctx.repositoryExpansion.unrecognisedAnswers).toBeUndefined();
    expect(ctx.repositoryExpansion.expansionClosed).toBeUndefined();
  });

  it("attaches nothing that only the text parser could read, and asks again", async () => {
    // The record's reader refused this answer on purpose: it is ambiguous by
    // its own rules, which are the careful ones. Letting the older parser
    // attach on the same sentence is the dumber reader overruling the one the
    // record exists to install (A45). The person is asked once more instead,
    // which is the cheaper mistake than a repository nobody chose.
    const ctx = resumedCtx("maybe the api one");
    const attach = vi.fn();

    const result = await applyHumanRepositoryExpansion(ctx, {
      resolve: async () => ({
        decision: { kind: "attach", repositories: [repository("github", "acme/api")] },
        workScope: { repositories: [] },
      }),
      attach,
      fetchContexts: vi.fn(),
    });

    expect(result).toEqual({ kind: "clarification", questions: ctx.clarifications?.at(-1)?.questions });
    expect(attach).not.toHaveBeenCalled();
    // Bounded by the same two unreadable answers, so this cannot loop.
    expect(ctx.repositoryExpansion.unrecognisedAnswers).toBe(1);
    expect(ctx.repositoryExpansion.expansionClosed).toBeUndefined();
  });

  it("honours a refusal the record wrote no entry for", async () => {
    // "none" to a question asked with reason selection legitimately writes no
    // entry, so the empty record beside `exhausted` is the answer rather than a
    // silence: the run closes expansion and asks nothing. Only an ATTACH the
    // record did not make is refused.
    const ctx = resumedCtx("none");

    const result = await applyHumanRepositoryExpansion(ctx, {
      resolve: async () => ({
        decision: { kind: "exhausted" },
        workScope: { repositories: [] },
      }),
      attach: vi.fn(),
      fetchContexts: vi.fn(),
    });

    expect(result.kind).toBe("noop");
    expect(ctx.repositoryExpansion.expansionClosed).toBe("human");
    expect(ctx.repositoryExpansion.unrecognisedAnswers).toBeUndefined();
  });

  it("leaves a previous run's answer to the previous run, and keeps expansion open", async () => {
    // Run 1 asked about a repository and a person answered "none". Every run on
    // the ticket reads the whole answered history, so that round is run 2's
    // latest one: applying it here closed run 2's expansion before its model had
    // said a word, and the first repository run 2 genuinely needed then failed
    // the run on a decision nobody had made about it (A42).
    const ctx = resumedCtx("none", { askedBy: "run-0" });
    const resolve = vi.fn();

    const result = await applyHumanRepositoryExpansion(ctx, {
      resolve,
      attach: vi.fn(),
      fetchContexts: vi.fn(),
    });

    expect(result.kind).toBe("noop");
    expect(resolve).not.toHaveBeenCalled();
    expect(ctx.repositoryExpansion.expansionClosed).toBeUndefined();
    // What run 2 does next with a repository the record decided nothing about:
    // it attaches it, where the re-applied answer used to fail the run.
    const requests = [requestFor("github", "acme/api")];
    const { action } = decideRepositoryExpansion({
      origin: "model",
      verdict: { kind: "attach", repositories: [repository("github", "acme/api")] },
      state: ctx.repositoryExpansion,
      requests,
    });
    expect(action.kind).toBe("attach");
  });

  it("gives the answer reader the question that was asked, not only the reply", async () => {
    // Our own words are not testimony: every channel a person answers through
    // quotes the question back, so the reader has to be able to tell the two
    // apart. It can only do that if the caller hands it the question.
    const ctx = resumedCtx("yes please");
    const resolve = vi.fn(async () => ({
      decision: { kind: "exhausted" as const },
      workScope: { repositories: [] },
    }));

    await applyHumanRepositoryExpansion(ctx, {
      resolve,
      attach: vi.fn(),
      fetchContexts: vi.fn(),
    });

    expect(resolve).toHaveBeenCalledWith(
      "yes please",
      expect.anything(),
      ctx.clarifications?.at(-1)?.questions,
    );
  });

  it("re-applies nothing for a round that names no run at all", async () => {
    // Only a journal written before the round carried a run id can produce one,
    // and an answer from a run nobody can name is not worth the risk of closing
    // this run's expansion with it: the question is asked again instead.
    const ctx = resumedCtx("none", { askedBy: null });
    const resolve = vi.fn();

    const result = await applyHumanRepositoryExpansion(ctx, {
      resolve,
      attach: vi.fn(),
      fetchContexts: vi.fn(),
    });

    expect(result.kind).toBe("noop");
    expect(resolve).not.toHaveBeenCalled();
    expect(ctx.repositoryExpansion.expansionClosed).toBeUndefined();
  });

  it("takes the old path when the run froze no work scope", async () => {
    const ctx = resumedCtx("gitlab:acme/shared");
    const attach = vi.fn(async () => ({ manifest: v2Manifest, cloneDurationMs: 1 }));

    const result = await applyHumanRepositoryExpansion(ctx, {
      // The shape a run suspended before this shipped replays: the verdict
      // alone, with no record beside it.
      resolve: async () => ({
        kind: "attach",
        repositories: [repository("gitlab", "acme/shared")],
      }),
      attach,
      fetchContexts: async () => [],
    });

    expect(result.kind).toBe("attached");
    expect(ctx.selectedRepositories.map((repo) => repo.repoPath)).toEqual([
      "acme/web",
      "acme/shared",
    ]);
  });
});

describe("this run's own answered round stays identifiable as this run's", () => {
  const asked = ["Repository expansion: research requested github:acme/api"];

  it("keeps a round whose question and answer an earlier run already saw", () => {
    // The prompt's dedupe is on the text alone, which is right for the prompt
    // and fatal here: it would drop this run's live answer, the re-apply would
    // see only the round an earlier run asked, and this run would park on the
    // same question again with nothing left able to end it.
    const earlier = { questions: asked, answer: "none", runId: "run-0" };
    const mine = { questions: asked, answer: "none", runId: "run-1" };

    const history = appendRunClarificationRound([earlier], mine);

    expect(history).toEqual([earlier, mine]);
  });

  it("still drops a retry of the same run's own answer", () => {
    const mine = { questions: asked, answer: "none", runId: "run-1" };

    expect(
      appendRunClarificationRound([mine], { questions: [...asked], answer: "none", runId: "run-1" }),
    ).toEqual([mine]);
  });
});

describe("what this run's own question settled decides the rounds after it", () => {
  const v2Manifest = { version: 2 as const, repositories: [] };
  const listed: TriggerRepositoryPolicy = {
    candidates: { kind: "listed", repositoryKeys: ["github:acme/web"] },
    expansion: "ask_once",
  };
  const catalog = [catalogEntry("github", "acme/web"), catalogEntry("github", "acme/api")];
  const attached = [{ provider: "github" as const, repoPath: "acme/web" }];

  /** The run as it wakes on the answer to its own question: it froze a record
   *  that said nothing, and the answer path has since written the exclusion. */
  async function resumeAfterAnswer() {
    const ctx = makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: v2Manifest,
      selectedRepositories: [repository("github", "acme/web")],
      clarifications: [
        {
          questions: ["Repository expansion: research requested github:acme/api"],
          answer: "none",
          runId: "run-1",
        },
      ],
      workScope: {
        subjectKey: SUBJECT,
        scope: null,
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });
    const answered = scopeOf(entry("github:acme/api", "excluded"));
    const result = await applyHumanRepositoryExpansion(ctx, {
      // What the resumed step read back: the record the answer left, and
      // nothing new to attach because the person declined it.
      resolve: async () => ({
        decision: { kind: "exhausted" },
        // What the step read back: the record as the answer left it, the flag
        // from the same read saying a person has now chosen, and which
        // repository that answer was actually about.
        workScope: {
          repositories: [],
          scope: answered,
          selectionAnswered: true,
          answeredRepositoryKeys: ["github:acme/api"],
        },
      }),
      attach: vi.fn(),
      fetchContexts: vi.fn(),
    });
    return { ctx, result, answered };
  }

  it("installs the record as the answer left it, the selection flag with it", async () => {
    const { ctx, answered } = await resumeAfterAnswer();

    expect(ctx.workScope?.scope).toEqual(answered);
    // The flag rides with the entries because it comes from the same read of
    // the same record and answers the same question: has a person chosen for
    // this subject. Left frozen, the run asks the selection question again
    // after its own answer settled it.
    expect(ctx.workScope?.selectionAnswered).toBe(true);
    // And WHICH repository that answer was about, for the same reason and from
    // the same read: the round after this one must tell rather than ask about
    // github:acme/api, and must still ask about a repository nobody has been
    // shown (A47).
    expect(ctx.workScope?.answeredRepositoryKeys).toEqual(["github:acme/api"]);
    // And the policy does NOT move, because a policy that changed mid-run would
    // give one run two different filters (A17, A10).
    expect(ctx.workScope?.subjectKey).toBe(SUBJECT);
  });

  it("refuses a repository the person just excluded instead of asking them again", async () => {
    const { ctx } = await resumeAfterAnswer();

    // The pass after the answer builds its recorder from the run context, so
    // the model asking again is refused with the decision the person just made
    // instead of parking them on the question they have answered.
    const record = recorderFor({
      scope: ctx.workScope?.scope ?? null,
      catalog,
      attached,
      policy: listed,
    });
    const verdict = validateAgainstRecord({
      requests: [requestFor("github", "acme/api")],
      catalog,
      attached,
      record,
    });

    expect(verdict.kind).toBe("refused");
    expect(record.ask).toEqual([]);
  });

  it("names who excluded the repository in the refusal, for an exclusion made in this run", async () => {
    const { ctx } = await resumeAfterAnswer();
    const record = recorderFor({
      scope: ctx.workScope?.scope ?? null,
      catalog,
      attached,
      policy: listed,
    });
    const verdict = validateAgainstRecord({
      requests: [requestFor("github", "acme/api")],
      catalog,
      attached,
      record,
    });
    expect(verdict.kind).toBe("refused");
    if (verdict.kind !== "refused") return;

    // The lookup the expansion closure makes, against the same run context.
    const recorded = new Map(
      (ctx.workScope?.scope?.entries ?? []).map((row) => [row.repositoryKey, row] as const),
    );
    const decided = recorded.get("github:acme/api");
    expect(decided).toBeDefined();
    const sentence = repositoryExpansionRefusalSentence(
      verdict.refusals[0]!,
      decided ? { decidedBy: decided.decidedBy, decidedAt: decided.decidedAt } : undefined,
    );

    expect(sentence).toContain("Ada Lovelace");
    expect(sentence).toContain("2026-09-10");
  });

  /**
   * The half-written result a run suspended across the deploy that added the
   * answered set replays: entries, the flag, and no answered set at all.
   *
   * The two are ONE value. A guess is refused by the entries and the answered
   * set read together, so a scope installed on its own puts a run's decisions
   * beside a set from another read, and nothing in the run can say which of the
   * two is the older. The pair the run start took in one read is therefore kept
   * whole, which is what this run did before the field existed.
   */
  async function resumeWithoutTheAnsweredSet() {
    const frozen = {
      subjectKey: SUBJECT,
      scope: scopeOf(entry("github:acme/api", "excluded")),
      selectionAnswered: false,
      answeredRepositoryKeys: [],
    };
    const ctx = makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: v2Manifest,
      selectedRepositories: [repository("github", "acme/web")],
      clarifications: [
        {
          questions: ["Repository expansion: research requested github:acme/db"],
          answer: "none",
          runId: "run-1",
        },
      ],
      workScope: frozen,
    });
    await applyHumanRepositoryExpansion(ctx, {
      resolve: async () => ({
        decision: { kind: "exhausted" },
        // An older deployment's step: the entries it read and the flag beside
        // them, with no answered set to read them against.
        workScope: { repositories: [], scope: scopeOf(), selectionAnswered: true },
      }),
      attach: vi.fn(),
      fetchContexts: vi.fn(),
    });
    return { ctx, frozen };
  }

  it("installs neither half of the pair when the step returned only the entries", async () => {
    const { ctx, frozen } = await resumeWithoutTheAnsweredSet();

    expect(ctx.workScope).toBe(frozen);
  });

  it("still refuses the repository the record decided, which the half the step returned had lost", async () => {
    const { ctx } = await resumeWithoutTheAnsweredSet();

    const record = recorderFor({
      scope: ctx.workScope?.scope ?? null,
      catalog,
      attached,
      policy: listed,
    });
    const verdict = validateAgainstRecord({
      requests: [requestFor("github", "acme/api")],
      catalog,
      attached,
      record,
    });

    expect(verdict.kind).toBe("refused");
    expect(record.ask).toEqual([]);
  });

  it("leaves the run on its frozen record when the step returned none", async () => {
    // The shape a run suspended before this shipped replays: repositories and
    // no record beside them. Moving nothing is what that run did.
    const frozen = {
      subjectKey: SUBJECT,
      scope: scopeOf(),
      selectionAnswered: false,
      answeredRepositoryKeys: [],
    };
    const ctx = makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: v2Manifest,
      selectedRepositories: [repository("github", "acme/web")],
      clarifications: [
        {
          questions: ["Repository expansion: research requested github:acme/api"],
          answer: "none",
          runId: "run-1",
        },
      ],
      workScope: frozen,
    });

    await applyHumanRepositoryExpansion(ctx, {
      resolve: async () => ({
        decision: { kind: "exhausted" },
        workScope: { repositories: [] },
      }),
      attach: vi.fn(),
      fetchContexts: vi.fn(),
    });

    expect(ctx.workScope).toBe(frozen);
  });
});

/**
 * Source tripwires, in the style of the one above `prepareClarificationHookStep`
 * in `work-scope-run-paths.test.ts`.
 *
 * The expansion loop is a closure inside `agentWorkflowBody` that no test can
 * invoke, so the two things a test can still hold are shapes: which functions
 * apply a write plan, and how a question about repositories is raised.
 */
const workflowLines = readFileSync(
  fileURLToPath(new URL("../agent-workflow.ts", import.meta.url)),
  "utf8",
).split("\n");

const phaseSource = readFileSync(
  fileURLToPath(new URL("../steps/phase.ts", import.meta.url)),
  "utf8",
);

/**
 * Every function in `source` that CALLS `name`, its own declaration excepted.
 *
 * Top-level declarations only, which is how every step and helper in `phase.ts`
 * is written; a call from anywhere else answers `<file scope>` and fails the
 * enumeration below rather than passing unnoticed.
 */
function callersOf(source: string, name: string): string[] {
  const callers: string[] = [];
  let enclosing = "<file scope>";
  for (const line of source.split("\n")) {
    const declared = /^(?:export )?(?:async )?function (\w+)[(<]/u.exec(line);
    if (declared?.[1]) enclosing = declared[1];
    if (!line.includes(`${name}(`) || declared) continue;
    if (!callers.includes(enclosing)) callers.push(enclosing);
  }
  return callers;
}

describe("nothing the expansion decides is written in workflow scope", () => {
  it("applies a plan only from a step the file gives maxRetries = 0", () => {
    // Workflow scope replays on every wake of a parked run, so a write there
    // would append the trail a second time. EVERY caller is enumerated, not a
    // sample of three: a plan applied from a new place inside a retrying step
    // would otherwise keep this green while every retry appended the trail
    // again.
    const carriers: Record<string, string> = {
      // what calls the applier: the step whose maxRetries = 0 covers that call
      writeAndStartPhase: "writeAndStartPhase",
      attachResearchRepositoriesStep: "attachResearchRepositoriesStep",
      resumeFromWorkScope: "resolveHumanRepositoryExpansionStep",
    };
    const callers = callersOf(phaseSource, "applyRunWorkScopePlans");

    expect(callers.length, "the plan appliers moved out of phase.ts").toBeGreaterThan(0);
    expect(
      [...callers].sort(),
      "a function applies a work scope plan that this enumeration does not recognise",
    ).toEqual(Object.keys(carriers).sort());

    for (const [caller, step] of Object.entries(carriers)) {
      expect(
        phaseSource.includes(`${step}.maxRetries = 0;`),
        `${step} carries a work scope plan and may not retry`,
      ).toBe(true);
      // A helper is only as safe as the steps that reach it, so the helpers get
      // their own callers checked too.
      if (caller === step) continue;
      expect(
        callersOf(phaseSource, caller),
        `${caller} applies a work scope plan and is now reached from somewhere else`,
      ).toEqual([step]);
    }
    expect(
      workflowLines.some((line) => line.includes("applyRunWorkScopePlans(")),
      "the workflow body applies a plan itself, which a replay would apply twice",
    ).toBe(false);
  });
});

/**
 * The resume reads the record AND what a question on it already settled.
 *
 * A source tripwire because the read is a deferred import inside a step body,
 * and the behaviour it feeds is asserted above: what a test cannot reach is
 * whether the step still asks the store for the second fact at all. Dropping it
 * would leave a woken run holding the empty set it froze at start, so the round
 * after its own answer would put the same repository to the same person twice
 * in one run (A47).
 *
 * The store is asked through the one read that answers the whole record
 * (`db/repositories/work-scope.ts`, `readWorkScopeFacts`), so the question this
 * scan puts is no longer whether a named read is still called but whether the
 * fact is still TAKEN off the picture and handed back.
 */
describe("a resumed run re-reads what its own question settled", () => {
  it("reads the answered repositories beside the record, not only the flag", () => {
    expect(
      phaseSource.includes("readConnectedWorkScopeFacts(resume.subjectKey)"),
      "the resume no longer re-reads the record its own question settled",
    ).toBe(true);
    expect(
      phaseSource.includes(
        "const { scope, selectionAnswered, answeredRepositoryKeys } =",
      ),
      "the resume no longer takes which repositories this subject has answered about",
    ).toBe(true);
    expect(
      phaseSource.includes(
        "return { repositories, scope, selectionAnswered, answeredRepositoryKeys };",
      ),
      "the resume reads the answered repositories and does not hand them back",
    ).toBe(true);
  });
});

/**
 * Every place in `agent-workflow.ts` that hands a run back PARKED ON A
 * QUESTION, with the top-level function it sits in.
 *
 * Two shapes park a run, and a scan that knew only the first would promise more
 * than it holds: a call to the `planningClarificationResult` envelope, and the
 * same object written out by hand. The envelope's own body is not a site.
 */
function parkingSitesIn(lines: string[]): string[] {
  const sites: string[] = [];
  let enclosing = "<file scope>";
  for (const raw of lines) {
    const declared = /^(?:export )?(?:async )?function (\w+)[(<]/u.exec(raw);
    if (declared?.[1]) enclosing = declared[1];
    const line = raw.trim();
    const parks =
      (line.includes("planningClarificationResult(") && !declared) ||
      line === `kind: "needs_human_input",`;
    if (!parks || enclosing === "planningClarificationResult") continue;
    sites.push(`${enclosing}: ${line}`);
  }
  return sites;
}

describe("every repository question goes through the one door that names its repositories", () => {
  it("parks a run on a question in agent-workflow.ts only from a place that is known to carry its ask", () => {
    // Both repository regions park only through `createRepositoryQuestions`,
    // which takes the asked repositories as an argument; a repository question
    // written straight against the envelope, or built by hand, would carry
    // none, its answer would be dropped, and the next run would ask the same
    // person the same thing (A41). The in-run DISCOVERY question used to be the
    // exception on this list and no longer is.
    expect(parkingSitesIn(workflowLines)).toEqual([
      // The door itself, and the only place either region reaches it.
      "createRepositoryQuestions: return planningClarificationResult(questions);",
      // The research agent's own questions, which are not about repositories.
      "agentWorkflowBody: return planningClarificationResult(questions, suggestedAnswers);",
      // The implementation agent's own questions, built by hand because that
      // branch carries the agent's suggested answers through unchanged. Not
      // about repositories either, and the only hand-built one there is.
      `agentWorkflowBody: kind: "needs_human_input",`,
    ]);
    expect(
      workflowLines.filter((line) => line.includes("repositoryQuestions.")).length,
      "a repository region no longer raises its questions through the door",
    ).toBe(3);
  });

  it("puts the asked repositories on the run context as the question is raised", () => {
    const ctx = makeCtx();
    const asked = {
      subjectKey: SUBJECT,
      askedRepositories: [
        { repositoryKey: "github:acme/api", askedBecause: "outside_policy" as const },
      ],
    };

    const raised = createRepositoryQuestions(ctx).raise(["Repository expansion: ..."], asked);

    expect(raised.kind).toBe("needs_human_input");
    expect(raised.questions).toEqual(["Repository expansion: ..."]);
    expect(ctx.workScopeAsk).toEqual(asked);
  });

  it("leaves nothing on the run context for a question that names no repository", () => {
    // The door assigns every time, including to nothing. A question that names
    // no repository must leave the field empty: inheriting the repositories an
    // earlier question put would record this answer against a repository nobody
    // asked this person about.
    const ctx = makeCtx();
    const door = createRepositoryQuestions(ctx);
    door.raise(["Repository expansion: the first question"], {
      subjectKey: SUBJECT,
      askedRepositories: [
        { repositoryKey: "github:acme/api", askedBecause: "outside_policy" as const },
      ],
    });

    door.raise(["Repository expansion: a question about nothing in particular"], null);

    expect(ctx.workScopeAsk).toBeUndefined();
  });
});
