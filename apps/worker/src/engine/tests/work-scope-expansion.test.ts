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
  repositoryExpansionRefusalPlan,
  repositoryExpansionRefusalSentence,
  validateRepositoryExpansionRequests,
} from "../repository-discovery/runner.js";
import { applyHumanRepositoryExpansion } from "../steps/phase.js";
import { createRunWorkScopeRecorder } from "../work-scope/context.js";
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
}) {
  return createRunWorkScopeRecorder({
    subjectKey: SUBJECT,
    scope: input.scope,
    selectionAnswered: false,
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
    expect(sentence).toContain("2026-09-10");
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

  it("gives a second question in the same run its own repositories, never the first one's", () => {
    const record = recorderFor({ scope: null, catalog, attached, policy: listed });

    const first = validateAgainstRecord({
      requests: [requestFor("github", "acme/api")],
      catalog,
      attached,
      record,
    });
    const second = validateAgainstRecord({
      requests: [requestFor("github", "acme/jobs")],
      catalog,
      attached,
      record,
    });

    expect(first.kind === "clarification_needed" && first.workScopeAsk).toEqual([
      { repositoryKey: "github:acme/api", askedBecause: "outside_policy" },
    ]);
    expect(second.kind === "clarification_needed" && second.workScopeAsk).toEqual([
      { repositoryKey: "github:acme/jobs", askedBecause: "outside_policy" },
    ]);
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

  function resumedCtx(answer: string) {
    return makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: v2Manifest,
      selectedRepositories: [repository("github", "acme/web")],
      clarifications: [
        {
          questions: ["Repository expansion: which repository should this run add?"],
          answer,
        },
      ],
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

  it("falls back to the protocol reader when the record recorded no new selection", async () => {
    // "none" writes an unavailable entry and selects nothing, so there is
    // nothing to attach and the run closes expansion exactly as it does today.
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

/**
 * A source tripwire, in the style of the one above `prepareClarificationHookStep`
 * in `work-scope-run-paths.test.ts`.
 *
 * The expansion loop is a closure inside `agentWorkflowBody` that no test can
 * invoke. What `consumeWorkScopeAsk` does is proved in `work-scope/context.test.ts`;
 * this asserts the one thing left: that the expansion still puts its asked
 * repositories on the run context before it parks on the question. A question
 * that reaches a person without them settles nothing, because the answer path
 * drops an answer whose clarification names no repository.
 */
const workflowLines = readFileSync(
  fileURLToPath(new URL("../agent-workflow.ts", import.meta.url)),
  "utf8",
).split("\n");

const phaseSource = readFileSync(
  fileURLToPath(new URL("../steps/phase.ts", import.meta.url)),
  "utf8",
);

describe("nothing the expansion decides is written in workflow scope", () => {
  it("applies a plan only from a step the file gives maxRetries = 0", () => {
    // Workflow scope replays on every wake of a parked run, so a write there
    // would append the trail a second time. The carriers are named here so a
    // plan moved onto a retrying step is caught by a test rather than by a
    // duplicated line in production.
    const carriers = phaseSource
      .split("\n")
      .filter((line) => line.includes("applyRunWorkScopePlans("))
      .filter((line) => !line.startsWith("async function"));
    expect(carriers.length, "the plan appliers moved out of phase.ts").toBeGreaterThan(0);

    for (const step of [
      "writeAndStartPhase",
      "attachResearchRepositoriesStep",
      "resolveHumanRepositoryExpansionStep",
    ]) {
      expect(
        phaseSource.includes(`${step}.maxRetries = 0;`),
        `${step} carries a work scope plan and may not retry`,
      ).toBe(true);
    }
    expect(
      workflowLines.some((line) => line.includes("applyRunWorkScopePlans(")),
      "the workflow body applies a plan itself, which a replay would apply twice",
    ).toBe(false);
  });
});

describe("the expansion ask reaches the question it was raised for", () => {
  it("sets the asked repositories on the run context beside the expansion clarification", () => {
    const index = workflowLines.findIndex((line) =>
      line.includes("decideRepositoryExpansion({"),
    );
    expect(index, "the expansion decision is no longer made in agent-workflow.ts").toBeGreaterThan(-1);

    const below = workflowLines.slice(index, index + 30);
    expect(
      below.some((line) => line.includes("ctx.workScopeAsk =")),
      "the expansion no longer puts its asked repositories on the run context, so an answer to its question settles nothing",
    ).toBe(true);
  });
});
