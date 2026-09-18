import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RepositoryListingFailure,
  RepositoryMetadata,
} from "../../adapters/vcs/repository-directory.js";
import type {
  TriggerRepositoryPolicy,
  WorkScope,
  WorkScopeActor,
  WorkScopeEntry,
  WorkScopeWritePlan,
} from "@shared/contracts";

const mocks = vi.hoisted(() => {
  const listRepositories = vi.fn();
  return {
    listRepositories,
    listRepositoriesAcrossProviders: vi.fn(
      async (): Promise<{
        repositories: RepositoryMetadata[];
        failures: RepositoryListingFailure[];
      }> => ({ repositories: await listRepositories(), failures: [] }),
    ),
    getConfiguredVcsProviders: vi.fn(),
    listWorkflowOwnedBranchesForTicket: vi.fn(),
    listRepositoryRules: vi.fn(),
    applyRunWorkScopePlan: vi.fn(),
    readWorkScope: vi.fn(),
    readSelectionAnswered: vi.fn(),
    readAnsweredKeys: vi.fn(),
    getMemoryDocument: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
  };
});

vi.mock("../../adapters/vcs/repository-directory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/vcs/repository-directory.js")>()),
  listRepositoriesAcrossProviders: mocks.listRepositoriesAcrossProviders,
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: {},
  getConfiguredVcsProviders: mocks.getConfiguredVcsProviders,
}));

vi.mock("../../db/repositories/runs.js", () => ({
  listConnectedWorkflowOwnedBranchesForTicket: (ticketKey: string) =>
    mocks.listWorkflowOwnedBranchesForTicket(ticketKey),
}));

vi.mock("../../db/repositories/repository-catalog.js", () => ({
  listConnectedRepositoryRules: (keys: string[]) => mocks.listRepositoryRules(keys),
}));

vi.mock("../../db/repositories/work-scope.js", () => ({
  applyConnectedRunWorkScopePlan: mocks.applyRunWorkScopePlan,
  // The picture a waking run reads, composed from the per-fact mocks so a case
  // sets each fact on its own.
  readConnectedWorkScopeFacts: async (subjectKey: string) => ({
    scope: await mocks.readWorkScope(subjectKey),
    selectionAnswered: await mocks.readSelectionAnswered(subjectKey),
    answeredRepositoryKeys: await mocks.readAnsweredKeys(subjectKey),
    narrowingAnswered: false,
    answeredQuestion: null,
  }),
}));

// The routing document store only. The document format is not mocked, so the
// remembered answer below is parsed exactly as production parses it.
vi.mock("../../db/repositories/memory.js", () => ({
  getConnectedMemoryDocument: (subjectKey: string, docPath: string) =>
    mocks.getMemoryDocument(subjectKey, docPath),
}));

vi.mock("../../infra/logger.js", () => ({ logger: mocks.logger }));

import { repoSelectionStep } from "./repo-selection.js";
import { commentPathAfterAnUnrecordedAnswer } from "../../engine/work-scope/context.js";
import { testSettingsSnapshot } from "../../test-support/settings.js";
import type { PreSandboxStepContext, PreSandboxStepResult } from "../../engine/pre-sandbox/types.js";
// The two places a clarification question ends up once a person answers it:
// verbatim in every agent prompt, and verbatim in the ticket's memory file.
import { assembleResearchPlanContext } from "../../sandbox/context.js";
import { renderHumanDecisionsSection } from "../../engine/support/human-decisions-memory.js";

const SUBJECT = "ticket:jira:AWT-402";
const ACTOR: WorkScopeActor = {
  kind: "run",
  runId: "run-2",
  definitionId: 40,
  definitionVersion: 3,
};
const ATTACH_EVERYTHING: TriggerRepositoryPolicy = {
  candidates: { kind: "enabled_catalog" },
  expansion: "attach",
};

function repo(repoPath: string, defaultBranch = "main"): RepositoryMetadata {
  const name = repoPath.split("/").pop()!;
  return {
    provider: "github",
    repoPath,
    name,
    owner: "acme",
    defaultBranch,
    description: `${name} repository`,
    webUrl: `https://github.com/${repoPath}`,
    topics: [],
    archived: false,
    private: true,
  };
}

const ALL = [
  repo("acme/web"),
  repo("acme/api"),
  repo("acme/docs"),
  repo("acme/infra"),
  repo("acme/ops"),
];

function entry(overrides: Partial<WorkScopeEntry> & { repositoryKey: string }): WorkScopeEntry {
  return {
    state: "selected",
    origin: "person",
    rationale: "named in the answer",
    decidedBy: { kind: "person", actorId: "p-1", actorLabel: "Ada" },
    decidedAt: "2026-09-15T09:00:00.000Z",
    ...overrides,
  } as WorkScopeEntry;
}

function scope(entries: WorkScopeEntry[], version = 4): WorkScope {
  return { subjectKey: SUBJECT, version, entries };
}

/** Everything a run carries into the selection. A case that is about the record
 *  passes `workScope`; a case that is about the old path leaves it out. */
async function runStep(
  overrides: {
    ticket?: PreSandboxStepContext["ticket"];
    repositories?: RepositoryMetadata[];
    enabledKeys?: string[];
    activated?: boolean;
    workScope?: PreSandboxStepContext["workScope"];
    policy?: TriggerRepositoryPolicy;
    clarification?: PreSandboxStepContext["clarification"];
    botAccountId?: string;
    repositoryScope?: PreSandboxStepContext["repositoryScope"];
    settings?: Parameters<typeof testSettingsSnapshot>[0];
  } = {},
): Promise<PreSandboxStepResult> {
  mocks.listRepositories.mockResolvedValueOnce(overrides.repositories ?? ALL);
  return repoSelectionStep({
    context: {
      repositoryAccess: {
        activated: overrides.activated ?? true,
        enabledKeys: overrides.enabledKeys ?? ALL.map((r) => `github:${r.repoPath}`),
      },
      settings: testSettingsSnapshot(overrides.settings),
      ticket: overrides.ticket ?? {
        identifier: "AWT-402",
        title: "Fix the thing",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      run: { branchName: "blazebot/awt-402" },
      ...(overrides.repositoryScope ? { repositoryScope: overrides.repositoryScope } : {}),
      ...(overrides.workScope ? { workScope: overrides.workScope } : {}),
      ...(overrides.workScope
        ? {
            workScopePolicy: overrides.policy ?? ATTACH_EVERYTHING,
            workScopeActor: ACTOR,
          }
        : {}),
      ...(overrides.clarification ? { clarification: overrides.clarification } : {}),
      ...(overrides.botAccountId ? { botAccountId: overrides.botAccountId } : {}),
    },
    config: undefined,
    step: { uses: "repo-selection", onFailure: "fail" },
  });
}

/** Every plan the step applied, flattened, so a case asserts on what reached
 *  the store rather than on how many statements it took. */
function appliedPlans(): WorkScopeWritePlan[] {
  return mocks.applyRunWorkScopePlan.mock.calls.map(
    (call) => (call[0] as { plan: WorkScopeWritePlan }).plan,
  );
}

function appliedTrail(): WorkScopeWritePlan["trail"] {
  return appliedPlans().flatMap((plan) => plan.trail);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRepositoryRules.mockResolvedValue([]);
  mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValue([]);
  mocks.applyRunWorkScopePlan.mockResolvedValue({ version: 5 });
  mocks.readWorkScope.mockResolvedValue(null);
  mocks.readSelectionAnswered.mockResolvedValue(false);
  mocks.readAnsweredKeys.mockResolvedValue([]);
  mocks.getMemoryDocument.mockResolvedValue(null);
  mocks.getConfiguredVcsProviders.mockReturnValue([
    {
      kind: "github",
      auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
      host: "https://github.com",
      legacyBaseBranch: "main",
    },
  ]);
});

describe("the workspace starts from the record", () => {
  it("attaches a repository a person selected on an earlier run and asks nobody", async () => {
    const result = await runStep({
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([entry({ repositoryKey: "github:acme/api" })]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("continue");
    expect(result.selectedRepositories).toEqual([
      expect.objectContaining({
        repoPath: "acme/api",
        selectedRationale: "recorded for this ticket",
      }),
    ]);
    expect(result.workScopeAsk).toBeUndefined();
  });

  it("leaves an unavailable entry out of the workspace, asks nobody, and says why", async () => {
    const result = await runStep({
      enabledKeys: ["github:acme/web"],
      repositories: [repo("acme/web")],
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({ repositoryKey: "github:acme/api", state: "selected", origin: "person" }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.selectedRepositories ?? []).not.toContainEqual(
      expect.objectContaining({ repoPath: "acme/api" }),
    );
    expect(result.workScopeAsk).toBeUndefined();
    const notes = JSON.stringify(result.promptAdditions ?? []) + (result.status === "halt" ? result.message : "");
    expect(notes).toContain("github:acme/api");
  });

  it("attaches an unavailable entry the catalog has since enabled, and records that it replaced it", async () => {
    const result = await runStep({
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({
            repositoryKey: "github:acme/api",
            state: "unavailable",
            unavailableReason: "not_enabled",
            origin: "person",
            rationale: "continue without it",
          }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.selectedRepositories).toEqual([
      expect.objectContaining({ repoPath: "acme/api" }),
    ]);
    const upserts = appliedPlans().flatMap((plan) => plan.upserts);
    expect(upserts).toEqual([
      expect.objectContaining({
        replacesExpired: true,
        entry: expect.objectContaining({
          repositoryKey: "github:acme/api",
          state: "selected",
          origin: "inferred",
        }),
      }),
    ]);
  });

  it("asks nobody and starts without the repository once an answer said to continue without it", async () => {
    // The AIW-402 shape. Run 1 asked; the answer wave wrote the entry the moment
    // the answer arrived, which is the only thing run 2 reads.
    const result = await runStep({
      repositories: [repo("acme/web")],
      enabledKeys: ["github:acme/web"],
      ticket: {
        identifier: "AWT-402",
        title: "Sync with acme/api",
        description: "The change spans acme/api.",
        acceptanceCriteria: "",
        comments: [{ author: "Ada", body: "continue without it", createdAt: "2026-09-15T09:00:00.000Z" }],
        labels: [],
      },
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({
            repositoryKey: "github:acme/api",
            state: "unavailable",
            unavailableReason: "not_enabled",
            origin: "person",
            rationale: "continue without it",
          }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.workScopeAsk).toBeUndefined();
    expect(result.status).toBe("continue");
    expect(result.selectedRepositories ?? []).not.toContainEqual(
      expect.objectContaining({ repoPath: "acme/api" }),
    );
  });
});

describe("a work scope write that fails", () => {
  it("logs work_scope_write_failed and lets the run continue rather than failing the step", async () => {
    mocks.applyRunWorkScopePlan.mockRejectedValueOnce(new Error("neon: connection reset"));

    const result = await runStep({
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({
            repositoryKey: "github:acme/api",
            state: "unavailable",
            unavailableReason: "not_enabled",
            origin: "person",
            rationale: "continue without it",
          }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("continue");
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      {
        subjectKey: SUBJECT,
        runId: "run-2",
        err: "neon: connection reset",
      },
      "work_scope_write_failed",
    );
  });
});

describe("the ambiguity question", () => {
  const FIVE_MATCHES = {
    identifier: "AWT-402",
    title: "Rename the client",
    description:
      "Touches acme/web, acme/api, acme/docs, acme/infra and acme/ops in one go.",
    acceptanceCriteria: "",
    comments: [],
    labels: [],
  };

  // The person answering this is scoping one afternoon's research, and what
  // they actually settle is every later guess on this work, the agent's own
  // mid-run request included. They are told, in the question, what leaving a
  // repository out costs. The lever that undoes it is NOT in the question,
  // because a question is copied verbatim into the research, implementation and
  // review prompts and into the ticket's memory file (rule 7): it rides the
  // ticket comment beside the question instead.
  it("says what an omission binds, and keeps the lever that undoes it out of the question", async () => {
    const result = await runStep({
      ticket: FIVE_MATCHES,
      workScope: {
        subjectKey: SUBJECT,
        scope: null,
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("halt");
    if (result.status !== "halt") throw new Error("expected a halt");
    const question = (result.questions ?? []).join(" ");
    expect(question).toContain("Reply with one or more of:");
    expect(question).toContain(
      "A repository you do not name is left out of this work from now on," +
        " and no later run takes it on its own.",
    );
    expect(question).not.toContain("work_scope.edit");
    expect(question).not.toContain("work scope API");

    // The way back, in the one channel the ticket comment renders beside the
    // question and no prompt ever sees.
    expect(result.workScopeRecoveryNotes).toEqual([
      "A repository you leave out of this answer is not final: this work's repository list" +
        " can be changed through the work scope API or the work_scope.edit tool, and the next" +
        " run starts from the changed list.",
    ]);
    expect(JSON.stringify(result.promptAdditions ?? [])).not.toContain("work_scope.edit");
  });

  // Skeptic F1 and F6 of the joint gate. An earlier run read two of these
  // repositories off the ticket and the record kept them, so this run starts
  // with them attached. A reply cannot remove them (an answer deletes a guess and
  // nothing else), so offering them as choices, under a sentence saying what is
  // not named is left out, told the person something false twice over.
  it("names the repositories the work already holds as taken, and offers only the rest", async () => {
    const result = await runStep({
      ticket: FIVE_MATCHES,
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({ repositoryKey: "github:acme/web", origin: "ticket_text", rationale: "run 1" }),
          entry({ repositoryKey: "github:acme/infra", origin: "ticket_text", rationale: "run 1" }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("halt");
    if (result.status !== "halt") throw new Error("expected a halt");
    // Only the open ones are asked about, so only they can be bound by the reply.
    expect(result.workScopeAsk?.askedRepositories.map((asked) => asked.repositoryKey)).toEqual([
      "github:acme/api",
      "github:acme/docs",
      "github:acme/ops",
    ]);
    const question = (result.questions ?? []).join(" ");
    expect(question).toContain(
      "Reply with one or more of: github:acme/api, github:acme/docs, github:acme/ops.",
    );
    // Joint gate round 3, R11: no claim about what else removes them. A
    // repository taken from the ticket's text also goes when the text stops
    // naming it, and a branch when the ledger drops it, so "only a change to
    // the list does" was false.
    expect(question).toContain(
      "Already part of this work, and kept whatever you reply: github:acme/web, github:acme/infra." +
        " Your reply does not remove them. Of the repositories you may reply with, one you do not" +
        " name is left out of this work from now on, and no later run takes it on its own.",
    );
    expect(question).not.toContain("only a change");
    // Rule 7 still holds for the new sentence.
    expect(question).not.toContain("work_scope.edit");
    expect(question).not.toContain("work scope API");
    expect(question).not.toContain("repository list");
    // Joint gate round 3, R12: the comment about an unrecorded answer knows
    // this question by its opening. Written and read through one constant; a
    // copy edit that broke the pair would turn this red, and would otherwise
    // quietly move the person to the less precise sentence.
    expect(commentPathAfterAnUnrecordedAnswer({ questions: result.questions ?? [] })).toBe(
      "too_many_open",
    );
  });

  it("derives an ordinary ticket text event when only three matches are still decidable", async () => {
    const result = await runStep({
      ticket: FIVE_MATCHES,
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({ repositoryKey: "github:acme/docs", state: "excluded", origin: "person" }),
          entry({
            repositoryKey: "github:acme/infra",
            state: "unavailable",
            unavailableReason: "unusable",
            origin: "person",
          }),
          entry({ repositoryKey: "github:acme/ops", state: "excluded", origin: "person" }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
      enabledKeys: ["github:acme/web", "github:acme/api", "github:acme/docs", "github:acme/ops"],
      repositories: [repo("acme/web"), repo("acme/api"), repo("acme/docs"), repo("acme/ops")],
    });

    expect(result.workScopeAsk).toBeUndefined();
    expect(result.status).toBe("continue");
    expect(
      (result.selectedRepositories ?? []).map((selected) => selected.repoPath).sort(),
    ).toEqual(["acme/api", "acme/web"]);
    const written = appliedTrail().filter((event) => event.kind === "entry_written");
    expect(written.map((event) => event.kind === "entry_written" && event.entry.origin)).toEqual([
      "ticket_text",
      "ticket_text",
    ]);
  });

  it("raises one selection question when more than three matches are still decidable", async () => {
    const result = await runStep({ ticket: FIVE_MATCHES, workScope: {
      subjectKey: SUBJECT,
      scope: null,
      selectionAnswered: false,
    } });

    expect(result.status).toBe("halt");
    if (result.status !== "halt") throw new Error("expected a halt");
    expect(result.outcome).toBe("needs_clarification");
    expect(result.workScopeAsk?.subjectKey).toBe(SUBJECT);
    expect(result.workScopeAsk?.askedRepositories.map((asked) => asked.repositoryKey)).toEqual([
      "github:acme/web",
      "github:acme/api",
      "github:acme/docs",
      "github:acme/infra",
      "github:acme/ops",
    ]);
    expect(
      result.workScopeAsk?.askedRepositories.every((asked) => asked.askedBecause === "selection"),
    ).toBe(true);
    expect(result.questions?.[0]).toContain("github:acme/web");
  });

  it("never asks the same subject twice, whatever the answer said", async () => {
    const result = await runStep({
      ticket: FIVE_MATCHES,
      workScope: { subjectKey: SUBJECT, scope: null, selectionAnswered: true, answeredRepositoryKeys: [] },
    });

    expect(result.workScopeAsk).toBeUndefined();
    expect(result.status).toBe("continue");
  });
});

describe("the bot's own comments", () => {
  const QUESTION =
    "Which repository should this ticket modify? Reply with one of: github:acme/api";

  it("does not read a repository key out of a comment this installation's bot wrote", async () => {
    const result = await runStep({
      botAccountId: "bot-account",
      repositories: [repo("acme/web"), repo("acme/api")],
      enabledKeys: ["github:acme/web", "github:acme/api"],
      ticket: {
        identifier: "AWT-402",
        title: "Fix the thing",
        description: "",
        acceptanceCriteria: "",
        comments: [
          { author: "AI Workflow", accountId: "bot-account", body: QUESTION, createdAt: "2026-09-15T09:00:00.000Z" },
        ],
        labels: [],
      },
    });

    expect(result.status).toBe("continue");
    expect(result.selectedRepositories).toBeUndefined();
    expect(result.repositoryDiscovery).toBeDefined();
  });

  it("still reads the same text when a person wrote it", async () => {
    const result = await runStep({
      botAccountId: "bot-account",
      repositories: [repo("acme/web"), repo("acme/api")],
      enabledKeys: ["github:acme/web", "github:acme/api"],
      ticket: {
        identifier: "AWT-402",
        title: "Fix the thing",
        description: "",
        acceptanceCriteria: "",
        comments: [
          { author: "Ada", accountId: "human-1", body: QUESTION, createdAt: "2026-09-15T09:00:00.000Z" },
        ],
        labels: [],
      },
    });

    expect(result.selectedRepositories).toEqual([
      expect.objectContaining({ repoPath: "acme/api" }),
    ]);
  });

  it("counts every comment when the bot identity could not be read", async () => {
    const result = await runStep({
      repositories: [repo("acme/web"), repo("acme/api")],
      enabledKeys: ["github:acme/web", "github:acme/api"],
      ticket: {
        identifier: "AWT-402",
        title: "Fix the thing",
        description: "",
        acceptanceCriteria: "",
        comments: [
          { author: "AI Workflow", accountId: "bot-account", body: QUESTION, createdAt: "2026-09-15T09:00:00.000Z" },
        ],
        labels: [],
      },
    });

    expect(result.selectedRepositories).toEqual([
      expect.objectContaining({ repoPath: "acme/api" }),
    ]);
  });
});

describe("a resumed run", () => {
  it("reads the record again rather than the answer it woke on", async () => {
    mocks.readWorkScope.mockResolvedValue(
      scope([entry({ repositoryKey: "github:acme/docs" })], 7),
    );
    mocks.readSelectionAnswered.mockResolvedValue(true);

    const result = await runStep({
      clarification: { answer: "acme/api", resolves: "repository_selection" },
      workScope: { subjectKey: SUBJECT, scope: null, selectionAnswered: false, answeredRepositoryKeys: [] },
    });

    expect(mocks.readWorkScope).toHaveBeenCalledWith(SUBJECT);
    expect(mocks.readSelectionAnswered).toHaveBeenCalledWith(SUBJECT);
    // The answer text named acme/api; the record names acme/docs, and the record
    // is what the run starts from.
    expect(result.selectedRepositories).toEqual([
      expect.objectContaining({ repoPath: "acme/docs" }),
    ]);
  });
});

describe("a run that read no record", () => {
  it("writes nothing and selects exactly what it selected before the record existed", async () => {
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Change the billing callback in acme/api.",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
    });

    expect(mocks.applyRunWorkScopePlan).not.toHaveBeenCalled();
    expect(mocks.readWorkScope).not.toHaveBeenCalled();
    expect(result.selectedRepositories).toEqual([
      expect.objectContaining({
        repoPath: "acme/api",
        selectedRationale: "ticket mentions repository path",
      }),
    ]);
    expect(result.workScopeAsk).toBeUndefined();
  });
});

/**
 * An empty `derived` event is a deletion: it removes every entry of its origin.
 * So the difference between "the evidence is gone" and "the evidence is there
 * but this run cannot act on it" is the difference between a corrected ticket
 * tidying up after itself and a ticket silently emptying its own scope with
 * nobody asked. The two cases below are deliberately side by side.
 */
describe("what an empty derived event may and may not erase", () => {
  it("erases the ticket text entries when the ticket no longer names anything", async () => {
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Fix the thing",
        description: "The callback is wrong.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({
            repositoryKey: "github:acme/api",
            origin: "ticket_text",
            rationale: "an earlier version of this ticket named it",
          }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("continue");
    expect(appliedPlans().flatMap((plan) => plan.deletes)).toContainEqual({
      repositoryKey: "github:acme/api",
      origin: "ticket_text",
    });
  });

  it("erases nothing when the ticket still names repositories this run cannot take", async () => {
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Fix the thing",
        description: "The callback in acme/api is wrong.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          // What a previous run derived from this ticket's text, and what a
          // wrong deletion here would take away from a person who never asked
          // for it.
          entry({ repositoryKey: "github:acme/docs", origin: "ticket_text" }),
          // The only thing the text still names, and a person has already said
          // no to it, so the match is not an open choice.
          entry({ repositoryKey: "github:acme/api", state: "excluded", origin: "person" }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("continue");
    expect(
      appliedPlans().flatMap((plan) =>
        plan.deletes.filter((deletion) => deletion.origin === "ticket_text"),
      ),
    ).toEqual([]);
    expect(
      (result.selectedRepositories ?? []).map((selected) => selected.repoPath),
    ).toContain("acme/docs");
    // The reason reaches a person instead of an empty scope with nothing behind
    // it, and it is now the precise one: their own exclusion, with the name and
    // the date on it. The vague restatement that used to accompany it is gone
    // rather than doubled, because both landed in the same paragraph.
    const leftOut = (result.promptAdditions ?? []).find(
      (addition) => addition.title === "Repositories left out",
    )?.content;
    expect(leftOut).toContain(
      "github:acme/api was excluded on this work by Ada on 2026-09-15",
    );
    expect(leftOut).not.toContain("could take none of them");
  });
});

/**
 * The workflow-owned branch entries are a fact about the branch ledger, so they
 * are re-derived on every run: the ledger IS the evidence, and an entry whose
 * branch the ledger no longer names has nothing left behind it. That makes the
 * deletion correct here and wrong in the ticket text case above, which is why
 * both halves are pinned.
 */
describe("what the workflow owned branch ledger erases", () => {
  it("drops an entry whose branch the ledger no longer names and keeps the one it still does", async () => {
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValue([
      {
        ticketKey: "AWT-402",
        provider: "github",
        repoPath: "acme/api",
        branchName: "blazebot/awt-402",
        pr: null,
      },
    ]);

    const result = await runStep({
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({
            repositoryKey: "github:acme/web",
            origin: "workflow_owned_branch",
            rationale: "a branch the ledger used to name",
          }),
          entry({
            repositoryKey: "github:acme/api",
            origin: "workflow_owned_branch",
            rationale: "a branch the ledger still names",
          }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("continue");
    const deletes = appliedPlans().flatMap((plan) => plan.deletes);
    expect(deletes).toContainEqual({
      repositoryKey: "github:acme/web",
      origin: "workflow_owned_branch",
    });
    expect(deletes).not.toContainEqual({
      repositoryKey: "github:acme/api",
      origin: "workflow_owned_branch",
    });
  });
});

describe("what a prior answer's prose may still decide", () => {
  // A path the token parser reads out of a sentence and the catalog does not
  // hold. Ungated, this is the branch that tells a person their answer named
  // something unavailable, which is a decision taken from prose written for an
  // earlier question, on an earlier run.
  const ANSWER = {
    identifier: "AWT-402",
    title: "Fix the thing",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    labels: [],
  };
  /** The reply, on the one channel that carries it: an answer is never
   *  appended to the ticket, so the path scanner cannot take a repository out
   *  of one. */
  const REPLIED: PreSandboxStepContext["clarification"] = {
    answer: "use acme/nope please",
    resolves: "repository_selection",
  };
  const NOT_AVAILABLE = "named in the previous answer are not available to this workflow";

  it("reads nothing out of the answer while a record is live", async () => {
    const result = await runStep({
      ticket: ANSWER,
      clarification: REPLIED,
      workScope: { subjectKey: SUBJECT, scope: scope([]), selectionAnswered: false, answeredRepositoryKeys: [] },
    });

    expect(result.status === "halt" ? (result.questions ?? []).join(" ") : "").not.toContain(
      NOT_AVAILABLE,
    );
  });

  // The control, and the reason the case above is worth anything: the same
  // sentence with no record behind it still decides. The gate is the record,
  // not the parser having gone blind.
  it("still reads the answer when there is no record", async () => {
    const result = await runStep({ ticket: ANSWER, clarification: REPLIED });

    expect(result.status).toBe("halt");
    if (result.status !== "halt") throw new Error("expected a halt");
    expect(result.questions?.[0]).toContain(NOT_AVAILABLE);
  });
});

describe("what the run says when the selection question is silenced", () => {
  it("names the repositories the ticket also names, and says it kept to the earlier choice", async () => {
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Fix the thing",
        description:
          "Touches acme/web, acme/api, acme/docs, acme/infra and acme/ops.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([entry({ repositoryKey: "github:acme/web" })]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("continue");
    expect(result.workScopeAsk).toBeUndefined();
    expect(result.selectedRepositories?.map((repo) => repo.repoPath)).toEqual(["acme/web"]);
    const addition = result.promptAdditions?.find(
      (entry_) => entry_.title === "Repositories left out",
    );
    expect(addition?.content).toContain(
      "The ticket also names github:acme/api, github:acme/docs, github:acme/infra, github:acme/ops, " +
        "and this run kept to the repositories already chosen on this work rather than asking again.",
    );
  });

  // Row B6: a person may take their entries out through the edit surface, and
  // the next run decides those repositories from scratch. What silences the
  // question does NOT come out with them, because it lives in the trail and
  // records that somebody was asked and answered, which removing an entry does
  // not unmake. So the run reaches this sentence holding an answer and no
  // selection at all, and the wording above would tell the person who just
  // emptied the list that the run kept to choices that no longer exist.
  it("says what is true when the record carries an answer and no selection at all", async () => {
    mocks.readSelectionAnswered.mockResolvedValue(true);
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Fix the thing",
        description: "Touches acme/web, acme/api, acme/docs, acme/infra and acme/ops.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      workScope: { subjectKey: SUBJECT, scope: scope([]), selectionAnswered: true, answeredRepositoryKeys: [] },
    });

    expect(result.workScopeAsk).toBeUndefined();
    expect(result.selectedRepositories ?? []).toEqual([]);
    const addition = result.promptAdditions?.find(
      (entry_) => entry_.title === "Repositories left out",
    );
    expect(addition?.content).toContain(
      "The ticket names github:acme/web, github:acme/api, github:acme/docs, github:acme/infra, " +
        "github:acme/ops, and this run did not ask which of them to start from because this work " +
        "already carries an answer to that question.",
    );
    // And never the claim it cannot support: there are no chosen repositories
    // on this run to have kept to.
    expect(addition?.content).not.toContain("kept to the repositories already chosen");
  });
});

// Joint gate round 3, R5 (the skeptic's probe P6). The ticket names four
// repositories, the person answered the which-of-these question naming acme/web,
// and every later run finishes on acme/web alone. Row C10 says the comment a
// finished run posts lists what it left out and says once what to do about it;
// on this path it listed nothing, because the silenced question left the three
// unnamed repositories in a paragraph only the agent reads.
describe("what a finished run says about the repositories an answer left out", () => {
  const FOUR = ["github:acme/api", "github:acme/docs", "github:acme/infra", "github:acme/web"];
  const unnamed = (repositoryKey: string) =>
    `${repositoryKey} was listed in a repository question already answered on this work` +
    " and is not selected on it, so the run started without it.";

  it("lists each one, keyed, with the way back that works while the ticket names four", async () => {
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Fix the thing",
        description: "Touches acme/web, acme/api, acme/docs and acme/infra.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      botAccountId: "bot-account",
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([entry({ repositoryKey: "github:acme/web" })]),
        selectionAnswered: true,
        answeredRepositoryKeys: FOUR,
        answeredAtByKey: Object.fromEntries(FOUR.map((key) => [key, "2026-09-16T09:00:00.000Z"])),
      },
    });

    expect(result.selectedRepositories?.map((repo) => repo.repoPath)).toEqual(["acme/web"]);
    expect(result.workScopeLeftOut).toEqual([
      { repositoryKey: "github:acme/api", reason: unnamed("github:acme/api") },
      { repositoryKey: "github:acme/docs", reason: unnamed("github:acme/docs") },
      { repositoryKey: "github:acme/infra", reason: unnamed("github:acme/infra") },
    ]);
    // Four open repositories: a path written in a comment would be asked about
    // rather than taken, so the record is the only way back offered.
    expect(result.workScopeRecoveryNotes).toEqual([
      "Leaving a repository out of an answer is not final: this work's repository list can be" +
        " changed through the work scope API or the work_scope.edit tool, and the next run starts" +
        " from the changed list.",
    ]);
    // Said once, in the keyed form, and not a second time in the paragraph.
    const addition = result.promptAdditions?.find(
      (entry_) => entry_.title === "Repositories left out",
    );
    expect(addition?.content).not.toContain("The ticket also names");
    expect(appliedTrail()).toEqual([]);
  });
});

/**
 * THE RUN THAT ASKED, WOKEN BY "whatever you think is best".
 *
 * The answer path wrote the workflow's choice as `delegated` entries and
 * resumed the run; the selection step now runs again from the top against the
 * same ticket, which still names every repository it named. What the person is
 * owed: the run works on exactly what was chosen for them, and nobody asks them
 * the question they just handed back.
 */
describe("the selection a delegation resumes into", () => {
  const delegated = (repositoryKey: string) =>
    entry({
      repositoryKey,
      origin: "delegated",
      rationale: "Chosen by the workflow because Ada asked it to decide.",
    });

  it("takes exactly the three the workflow chose and asks nothing", async () => {
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Fix the thing",
        description: "Touches acme/web, acme/api, acme/docs and acme/infra.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          delegated("github:acme/web"),
          delegated("github:acme/api"),
          delegated("github:acme/docs"),
        ]),
        // A delegation raises neither: it binds only what it took.
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("continue");
    expect(result.workScopeAsk).toBeUndefined();
    expect(result.selectedRepositories?.map((each) => each.repoPath).sort()).toEqual([
      "acme/api",
      "acme/docs",
      "acme/web",
    ]);
  });

  it("does not describe the delegated choice as repositories taken without asking", async () => {
    const result = await runStep({
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          delegated("github:acme/web"),
          delegated("github:acme/api"),
          delegated("github:acme/docs"),
          entry({ repositoryKey: "github:acme/ops", origin: "trigger_policy" }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("continue");
    const leftOut =
      result.promptAdditions?.find((addition) => addition.title === "Repositories left out")
        ?.content ?? "";
    expect(leftOut).not.toContain("github:acme/web");
  });
});

describe("what a person reads when the run stops to ask", () => {
  it("puts the refusal in front of the question, where the halt message never reaches", async () => {
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Fix the thing",
        description:
          "Touches acme/web, acme/api, acme/docs, acme/infra and acme/ops.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({ repositoryKey: "github:acme/legacy", origin: "trigger_policy" }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("halt");
    if (result.status !== "halt") throw new Error("expected a halt");
    expect(result.outcome).toBe("needs_clarification");
    expect(result.questions?.[0]).toContain(
      "github:acme/legacy is not on the repository catalog this run may use",
    );
    expect(result.questions?.[0]).toContain("acme/web");
  });

  // The two channels, pinned from both sides. The recovery sentence goes where a
  // person reads and is never PLACED in the agent's instruction channel; the
  // refusal itself goes to both, because it is a fact about this run's
  // workspace and the agent needs it.
  it("tells a person the exclusion can be taken back when the run stops, in the text a person reads", async () => {
    // A workflow-owned branch on a repository the person excluded: the ledger
    // names it, the record refuses it, and the ticket text leaves four other
    // repositories open, so the run stops to ask.
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValue([
      {
        ticketKey: "AWT-402",
        provider: "github",
        repoPath: "acme/ops",
        branchName: "blazebot/awt-402",
        pr: null,
      },
    ]);
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Rename the client",
        description:
          "Touches acme/web, acme/api, acme/docs, acme/infra and acme/ops in one go.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({ repositoryKey: "github:acme/ops", state: "excluded", origin: "person" }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("halt");
    if (result.status !== "halt") throw new Error("expected a halt");
    expect(result.message).toContain(
      "github:acme/ops was excluded on this work by Ada on 2026-09-15," +
        " so the run started without it.",
    );
    expect(result.message).toContain(
      "Excluding a repository is not final: this work's repository list can be changed" +
        " through the work scope API or the work_scope.edit tool," +
        " and the next run starts from the changed list.",
    );
  });

  it("keeps the recovery sentence out of the instructions when the run carries on", async () => {
    // The one repository this run can see is the one a person excluded, so the
    // refusal is real and the run carries on to discovery without it.
    const result = await runStep({
      repositories: [repo("acme/api")],
      enabledKeys: ["github:acme/api"],
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({ repositoryKey: "github:acme/api", state: "excluded", origin: "person" }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("continue");
    const addition = result.promptAdditions?.find(
      (each) => each.title === "Repositories left out",
    );
    expect(addition?.content).toContain(
      "github:acme/api was excluded on this work by Ada on 2026-09-15," +
        " so the run started without it.",
    );
    expect(JSON.stringify(result.promptAdditions ?? [])).not.toContain("not final");
  });

  // A question is not a private note to the person. Once answered it becomes a
  // clarification round, and a clarification round is copied verbatim into the
  // research, implementation and review prompts AND into the ticket's memory
  // file under a heading that tells the agent not to edit it. So the two
  // downstream renderers are the real guard on what may ride a question, not
  // the promptAdditions the other tests check.
  it("keeps the recovery sentence out of the question, so no prompt and no memory file repeats it", async () => {
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValue([
      {
        ticketKey: "AWT-402",
        provider: "github",
        repoPath: "acme/ops",
        branchName: "blazebot/awt-402",
        pr: null,
      },
    ]);
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Rename the client",
        description:
          "Touches acme/web, acme/api, acme/docs, acme/infra and acme/ops in one go.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({ repositoryKey: "github:acme/ops", state: "excluded", origin: "person" }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("halt");
    if (result.status !== "halt") throw new Error("expected a halt");
    const questions = result.questions ?? [];
    expect(questions.length).toBeGreaterThan(0);
    // The refusal itself does ride the question: it is a fact about the
    // workspace the answer is about, and the person needs it to answer.
    expect(questions[0]).toContain(
      "github:acme/ops was excluded on this work by Ada on 2026-09-15," +
        " so the run started without it.",
    );
    expect(questions.join(" ")).not.toContain("not final");

    // Answered, the round reaches the agent's research prompt.
    const prompt = assembleResearchPlanContext({
      ticket: {
        identifier: "AWT-402",
        title: "Rename the client",
        description: "Touches acme/web, acme/api, acme/docs, acme/infra and acme/ops in one go.",
        acceptanceCriteria: "",
        comments: [],
        clarifications: [{ questions, answer: "Use acme/web." }],
      },
      prompt: "Plan the work.",
      branchName: "blazebot/awt-402",
    });
    expect(prompt).toContain("## Clarifications (Q&A)");
    expect(prompt).toContain(
      "github:acme/ops was excluded on this work by Ada on 2026-09-15," +
        " so the run started without it.",
    );
    expect(prompt).not.toContain("not final");

    // And the same round is written to ai-workflow/memory/AWT-402.md.
    const memory = renderHumanDecisionsSection([{ questions, answer: "Use acme/web." }]);
    expect(memory).toContain("## Human decisions (from the dashboard)");
    expect(memory).toContain(
      "github:acme/ops was excluded on this work by Ada on 2026-09-15," +
        " so the run started without it.",
    );
    expect(memory).not.toContain("not final");

    // The person's own channel still carries it.
    expect(result.message).toContain("not final");
  });
});

describe("the count gate with a record behind it", () => {
  const SIX = [...ALL, repo("acme/tools")];
  const SIX_KEYS = SIX.map((each) => `github:${each.repoPath}`);
  const recordOfSix = (entries: WorkScopeEntry[] = []) =>
    scope([
      ...SIX_KEYS.map((repositoryKey) => entry({ repositoryKey, origin: "trigger_policy" })),
      ...entries,
    ]);

  // Joint gate, F6. Every one of the six is a selection the record already holds
  // (the trigger policy wrote it), the run start attached all six, and a reply
  // cannot remove a policy's selection. Asking which of them are essential
  // offered six choices that none of the answers could act on. So the gate
  // asks nothing, takes the six, and says so.
  it("asks nothing when every repository it would offer is one the record already holds", async () => {
    const result = await runStep({
      repositories: SIX,
      enabledKeys: SIX_KEYS,
      workScope: { subjectKey: SUBJECT, scope: recordOfSix(), selectionAnswered: false, answeredRepositoryKeys: [] },
    });

    expect(result.status).toBe("continue");
    expect(result.workScopeAsk).toBeUndefined();
    expect(result.selectedRepositories).toHaveLength(6);
    expect(
      result.promptAdditions?.find((addition) => addition.title === "Repositories left out")
        ?.content,
    ).toContain(
      "This run also took github:acme/api, github:acme/docs, github:acme/infra, github:acme/ops, " +
        "github:acme/tools, github:acme/web without asking which repositories to start from, " +
        "because the repositories on this work were already decided.",
    );
  });

  // The whole defence against a second loop: a question nobody may be asked
  // twice must never stop a run, because its answer would change nothing and the
  // next run would count the same repositories and ask again.
  it("does not stop the run when the question is already settled, and says what it took", async () => {
    const result = await runStep({
      repositories: SIX,
      enabledKeys: SIX_KEYS,
      workScope: { subjectKey: SUBJECT, scope: recordOfSix(), selectionAnswered: true, answeredRepositoryKeys: [] },
    });

    expect(result.status).toBe("continue");
    expect(result.workScopeAsk).toBeUndefined();
    expect(result.selectedRepositories?.map((each) => each.repoPath)).toEqual([
      "acme/api",
      "acme/docs",
      "acme/infra",
      "acme/ops",
      "acme/tools",
      "acme/web",
    ]);
    expect(
      result.promptAdditions?.find((addition) => addition.title === "Repositories left out")
        ?.content,
    ).toContain(
      "This run also took github:acme/api, github:acme/docs, github:acme/infra, github:acme/ops, " +
        "github:acme/tools, github:acme/web without asking which repositories to start from, " +
        "because the repositories on this work were already decided.",
    );
  });

  it("counts only what a person did not decide, so four of their own repositories ask nothing", async () => {
    const chosen = SIX_KEYS.slice(0, 4);
    const result = await runStep({
      repositories: SIX,
      enabledKeys: SIX_KEYS,
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          ...chosen.map((repositoryKey) => entry({ repositoryKey })),
          ...SIX_KEYS.slice(4).map((repositoryKey) =>
            entry({ repositoryKey, origin: "trigger_policy" }),
          ),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.status).toBe("continue");
    expect(result.selectedRepositories).toHaveLength(6);
    expect(result.workScopeAsk).toBeUndefined();
    // Nothing to explain either: the gate never fired, so there is no sentence
    // about a question that was never silenced.
    expect(
      result.promptAdditions?.some((addition) => addition.title === "Repositories left out"),
    ).toBeFalsy();
  });

  // The other half of the same rule: with no record the gate is the count over
  // every signal and the question is the generic one, word for word as before.
  it("leaves the run with no record on exactly the question it asked before", async () => {
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Fix the thing",
        description: "Touches acme/web, acme/api, acme/docs and acme/infra.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
    });

    expect(result.status).toBe("halt");
    if (result.status !== "halt") throw new Error("expected a halt");
    expect(result.questions).toEqual([
      "More than 3 repositories match this ticket. Which repositories are essential for the initial research?",
    ]);
    expect(result.workScopeAsk).toBeUndefined();
  });
});

/**
 * THE SILENT CASE, end to end over every hop that can be executed.
 *
 * A ticket covers two repositories, a person excluded one of them weeks ago,
 * the run attaches the other, does NOT halt, finishes and ships a pull request
 * covering half the work. Every surface that reaches a person on this feature
 * reaches them when the run STOPS; this is the path where it does not, and
 * nobody goes looking for a problem a green run did not report.
 *
 * So the chain is walked with the real code at each hop: the selection step
 * decides and returns, the pre-sandbox runner carries, and the report builder
 * renders the comment the finished run posts. The two hops a test cannot
 * invoke, the assignment inside the prepare-workspace block body and the
 * seeding inside the workflow body, are pinned in their own suites.
 */
describe("what the person reads when the run leaves a repository out and carries on", () => {
  it("names the repository in the comment a finished run posts, and says the exclusion can be taken back", async () => {
    const { executePreSandboxPhase } = await import("../../engine/steps/pre-sandbox-runner.js");
    const { buildResearchAnalysisReport, formatResearchAnalysisComment } = await import(
      "../../engine/support/run-analysis-report.js"
    );

    const selection = await runStep({
      // The only repository this run can see is the one a person excluded, so
      // the refusal is real and the run carries on without it.
      repositories: [repo("acme/api")],
      enabledKeys: ["github:acme/api"],
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({ repositoryKey: "github:acme/api", state: "excluded", origin: "person" }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });
    expect(selection.status).toBe("continue");

    const phase = await executePreSandboxPhase(
      {
        ticket: { identifier: "AWT-402" },
        run: { branchName: "blazebot/awt-402" },
        repositoryAccess: { activated: true, enabledKeys: ["github:acme/api"] },
        settings: testSettingsSnapshot(),
      },
      { preSandbox: { steps: [{ uses: "repo-selection", onFailure: "fail" }] } },
      { "repo-selection": async () => selection },
    );

    expect(phase.status).toBe("continue");
    expect(phase.workScopeLeftOut).toEqual([
      {
        repositoryKey: "github:acme/api",
        reason:
          "github:acme/api was excluded on this work by Ada on 2026-09-15," +
          " so the run started without it.",
      },
    ]);

    const report = buildResearchAnalysisReport({
      runId: "run-silent",
      workspaceManifest: {
        repositories: [
          {
            provider: "github",
            repoPath: "acme/web",
            defaultBranch: "main",
            branchName: "arthur/AWT-402",
            researchBaseSha: "abcdef123456",
            access: "write",
          },
        ],
      },
      ...(phase.workScopeLeftOut ? { leftOutRepositories: phase.workScopeLeftOut } : {}),
      ...(phase.workScopeRecoveryNotes
        ? { repositoryRecoveryNotes: phase.workScopeRecoveryNotes }
        : {}),
      researchResult: { body: "Plan" },
    });
    const comment = formatResearchAnalysisComment(
      report,
      "https://dashboard.example/runs/run-silent",
    );
    const repositories = comment
      .split("\n\n")
      .find((section) => section.startsWith("Repositories"));

    expect(repositories).toContain(
      "- github:acme/api · left out · github:acme/api was excluded on this work" +
        " by Ada on 2026-09-15," +
        " so the run started without it.",
    );
    expect(repositories).toContain(
      "Excluding a repository is not final: this work's repository list can be changed" +
        " through the work scope API or the work_scope.edit tool," +
        " and the next run starts from the changed list.",
    );
    // And still not in the agent's instruction channel, on the same run.
    expect(JSON.stringify(phase.promptAdditions)).toContain("was excluded on this work");
    expect(JSON.stringify(phase.promptAdditions)).not.toContain("not final");
  });
});

/**
 * The production shape of 18.09. A person wrote one comment whose whole body was
 * a repository path, that repository is a row this deployment holds and keeps
 * disabled, and the run worked in the repository the description named and
 * finished green. The path appeared nowhere a person could read it: not in the
 * clarification comment, not in the analysis comment, not in the run's status.
 *
 * The scan that reads the ticket's text matches against the ENABLED part of the
 * listing, so a disabled row can never match it and the mention was dropped
 * before anything could say so.
 */
describe("a repository this deployment holds and this run may not open, named on the ticket", () => {
  // The listing the providers answer with, and the one row of it the catalog
  // enables. `acme/ops` is the disabled row: real here, off limits to this run.
  const LISTED = [repo("acme/web"), repo("acme/ops")];
  const ENABLED = ["github:acme/web"];
  const NO_ANSWER: PreSandboxStepContext["workScope"] = {
    subjectKey: SUBJECT,
    scope: scope([]),
    selectionAnswered: false,
    answeredRepositoryKeys: [],
  };
  const human = (body: string, createdAt = "2026-09-18T08:00:00.000Z") => ({
    author: "Ada",
    accountId: "human-1",
    body,
    createdAt,
  });
  const ticketWith = (
    comments: Array<ReturnType<typeof human>>,
    description = "Fix the billing callback in acme/web.",
  ) => ({
    identifier: "AWT-402",
    title: "Invoices are wrong",
    description,
    acceptanceCriteria: "",
    comments,
    labels: [] as string[],
  });
  const NOT_ON_THE_CATALOG =
    "github:acme/ops is not on the repository catalog this run may use," +
    " so the run started without it.";
  const THE_WAY_BACK =
    "github:acme/ops is not enabled on the Repositories page. Somebody with access to that" +
    " page can enable it, and until then no run can use it.";

  it("names it in the comment a finished run posts, and works in the repository it was given", async () => {
    const { executePreSandboxPhase } = await import("../../engine/steps/pre-sandbox-runner.js");
    const { buildResearchAnalysisReport, formatResearchAnalysisComment } = await import(
      "../../engine/support/run-analysis-report.js"
    );

    const selection = await runStep({
      repositories: LISTED,
      enabledKeys: ENABLED,
      ticket: ticketWith([human("acme/ops")]),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    // The run does what it did before: nobody is asked, the workspace is the
    // repository the description named, and the run carries on.
    expect(selection.status).toBe("continue");
    expect(selection.workScopeAsk).toBeUndefined();
    expect(selection.selectedRepositories?.map((chosen) => chosen.repoPath)).toEqual([
      "acme/web",
    ]);
    expect(selection.workScopeLeftOut).toEqual([
      { repositoryKey: "github:acme/ops", reason: NOT_ON_THE_CATALOG },
    ]);

    const phase = await executePreSandboxPhase(
      {
        ticket: { identifier: "AWT-402" },
        run: { branchName: "blazebot/awt-402" },
        repositoryAccess: { activated: true, enabledKeys: ENABLED },
        settings: testSettingsSnapshot(),
      },
      { preSandbox: { steps: [{ uses: "repo-selection", onFailure: "fail" }] } },
      { "repo-selection": async () => selection },
    );
    const report = buildResearchAnalysisReport({
      runId: "run-mention",
      workspaceManifest: {
        repositories: [
          {
            provider: "github",
            repoPath: "acme/web",
            defaultBranch: "main",
            branchName: "arthur/AWT-402",
            researchBaseSha: "abcdef123456",
            access: "write",
          },
        ],
      },
      ...(phase.workScopeLeftOut ? { leftOutRepositories: phase.workScopeLeftOut } : {}),
      ...(phase.workScopeRecoveryNotes
        ? { repositoryRecoveryNotes: phase.workScopeRecoveryNotes }
        : {}),
      researchResult: { body: "Plan" },
    });
    const repositories = formatResearchAnalysisComment(
      report,
      "https://dashboard.example/runs/run-mention",
    )
      .split("\n\n")
      .find((section) => section.startsWith("Repositories"));

    expect(repositories).toContain(`- github:acme/ops · left out · ${NOT_ON_THE_CATALOG}`);
    expect(repositories).toContain(THE_WAY_BACK);
    // And the repository the run DID open is not also reported as left out.
    expect(repositories).not.toContain("github:acme/web · left out");
  });

  it("says nothing at all about a path no provider offered", async () => {
    const selection = await runStep({
      repositories: LISTED,
      enabledKeys: ENABLED,
      // A person naming somebody else's repository, a pasted URL or a quoted
      // log. Reporting it would mean guessing the string was meant as a
      // repository here at all.
      ticket: ticketWith([human("compare it with otherorg/secret-thing")]),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    expect(selection.status).toBe("continue");
    expect(selection.workScopeLeftOut).toBeUndefined();
    expect(selection.workScopeRecoveryNotes).toBeUndefined();
    expect(
      selection.promptAdditions?.find((addition) => addition.title === "Repositories left out"),
    ).toBeUndefined();
    expect(selection.selectedRepositories?.map((chosen) => chosen.repoPath)).toEqual([
      "acme/web",
    ]);
  });

  it("says it once when the description and two comments all name it", async () => {
    const selection = await runStep({
      repositories: LISTED,
      enabledKeys: ENABLED,
      ticket: ticketWith(
        [
          human("acme/ops", "2026-09-18T08:00:00.000Z"),
          human("still needs acme/ops", "2026-09-18T09:00:00.000Z"),
        ],
        "Fix the billing callback in acme/web, which calls acme/ops.",
      ),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    expect(selection.workScopeLeftOut).toEqual([
      { repositoryKey: "github:acme/ops", reason: NOT_ON_THE_CATALOG },
    ]);
    const addition = selection.promptAdditions?.find(
      (entry_) => entry_.title === "Repositories left out",
    );
    expect(addition?.content.match(/github:acme\/ops/g)).toHaveLength(1);
  });

  it("keeps the way back off the agent's channel and on the person's", async () => {
    const selection = await runStep({
      repositories: LISTED,
      enabledKeys: ENABLED,
      ticket: ticketWith([human("acme/ops")]),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    // Rule 7: what happened is a fact about this run's workspace and the agent
    // reads it; how to get the repository back is a lever for a person only.
    const addition = selection.promptAdditions?.find(
      (entry_) => entry_.title === "Repositories left out",
    );
    expect(addition?.content).toContain(NOT_ON_THE_CATALOG);
    expect(JSON.stringify(selection.promptAdditions ?? [])).not.toContain(
      "Repositories page",
    );
    expect(selection.workScopeRecoveryNotes).toContain(THE_WAY_BACK);
  });

  it("writes nothing to the record about it", async () => {
    const selection = await runStep({
      repositories: LISTED,
      enabledKeys: ENABLED,
      ticket: ticketWith([human("acme/ops")]),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    // Both halves, because either one alone passes on a run that says nothing:
    // the mention IS reported, and reporting it decided nothing. Nobody decided
    // anything about ops, a person mentioned it and this deployment cannot serve
    // it, so a `decide` here would write an entry a later run reads as a
    // decision somebody took. The run DID write what it decided about web, so
    // this is a record that was written and left ops out of it.
    expect(selection.workScopeLeftOut).toEqual([
      { repositoryKey: "github:acme/ops", reason: NOT_ON_THE_CATALOG },
    ]);
    // Every statement the step applied, upserts, deletes and trail lines
    // together, because a mention must not reach any of them.
    const plans = JSON.stringify(appliedPlans());
    expect(plans).toContain("github:acme/web");
    expect(plans).not.toContain("github:acme/ops");
  });
});

/**
 * The same silence one bound over. A repository this deployment ENABLES, which
 * the workflow's own pin leaves out, is a real mismatch: the person expects the
 * work to touch it and this workflow cannot. Its reason is its own, because the
 * two bounds are undone by different people: the catalog needs somebody with the
 * Repositories page, the pin needs the workflow's scope changed.
 */
describe("a repository the catalog enables and this workflow's pin leaves out", () => {
  // web is pinned and enabled, docs is enabled and outside the pin, ops is
  // neither enabled nor pinned.
  const LISTED = [repo("acme/web"), repo("acme/docs"), repo("acme/ops")];
  const ENABLED = ["github:acme/web", "github:acme/docs"];
  const PINNED_TO_WEB = {
    repositories: [{ provider: "github" as const, repoPath: "acme/web" }],
  };
  const NO_ANSWER: PreSandboxStepContext["workScope"] = {
    subjectKey: SUBJECT,
    scope: scope([]),
    selectionAnswered: false,
    answeredRepositoryKeys: [],
  };
  const ticketNaming = (comment: string) => ({
    identifier: "AWT-402",
    title: "Invoices are wrong",
    description: "Fix the billing callback in acme/web.",
    acceptanceCriteria: "",
    comments: [
      { author: "Ada", accountId: "human-1", body: comment, createdAt: "2026-09-18T08:00:00.000Z" },
    ],
    labels: [] as string[],
  });
  const OUTSIDE_THE_PIN =
    "github:acme/docs is outside the repositories the workflow that runs this work may take," +
    " so the run started without it.";
  const THE_PIN_WAY_BACK =
    "The workflow that runs this work is limited to a fixed set of repositories, which does not" +
    " include github:acme/docs, so no run of it can use that repository until that limit changes.";

  it("names it with the pin's own reason, not the catalog's", async () => {
    const selection = await runStep({
      repositories: LISTED,
      enabledKeys: ENABLED,
      repositoryScope: PINNED_TO_WEB,
      ticket: ticketNaming("acme/docs has the other half of this"),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    expect(selection.status).toBe("continue");
    expect(selection.selectedRepositories?.map((chosen) => chosen.repoPath)).toEqual([
      "acme/web",
    ]);
    expect(selection.workScopeLeftOut).toEqual([
      { repositoryKey: "github:acme/docs", reason: OUTSIDE_THE_PIN },
    ]);
    // The lever that moves this one is the workflow's scope, and saying
    // "enable it on the Repositories page" here would send the person to a
    // screen where the repository is already enabled.
    expect(selection.workScopeRecoveryNotes).toContain(THE_PIN_WAY_BACK);
    expect(JSON.stringify(selection.workScopeRecoveryNotes ?? [])).not.toContain(
      "Repositories page",
    );
  });

  it("says one line, the catalog's, about a repository that is disabled AND outside the pin", async () => {
    const selection = await runStep({
      repositories: LISTED,
      enabledKeys: ENABLED,
      repositoryScope: PINNED_TO_WEB,
      ticket: ticketNaming("acme/ops has the other half of this"),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    // Two true facts, one repository, one line: a person who reads that it is
    // not on the catalog has nothing to do with a second line about the pin.
    expect(selection.workScopeLeftOut).toEqual([
      {
        repositoryKey: "github:acme/ops",
        reason:
          "github:acme/ops is not on the repository catalog this run may use," +
          " so the run started without it.",
      },
    ]);
    expect(JSON.stringify(selection.workScopeLeftOut)).not.toContain("may take");
  });

  it("says nothing about a pin to a workflow that has none, however many the ticket names and the run leaves", async () => {
    const selection = await runStep({
      // Five enabled repositories, no pin, and a ticket naming four of them: the
      // run asks which to start from and takes NONE. The repositories it did not
      // take are the trap, because "left out" reads as "report them all". With no
      // pin there is nothing for any of them to be outside of, and a line saying
      // so would be a sentence about a limit this workflow does not have, with a
      // way back that changes nothing.
      repositories: ALL,
      enabledKeys: ALL.map((listed) => `github:${listed.repoPath}`),
      ticket: {
        identifier: "AWT-402",
        title: "Invoices are wrong",
        description: "Touches acme/web, acme/api, acme/docs and acme/infra.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    expect(JSON.stringify(selection)).not.toContain("outside the repositories");
    expect(JSON.stringify(selection)).not.toContain("limited to a fixed set");
  });

  it("stays silent on a pinned workflow about a path no provider offered", async () => {
    const selection = await runStep({
      repositories: LISTED,
      enabledKeys: ENABLED,
      repositoryScope: PINNED_TO_WEB,
      ticket: ticketNaming("compare it with otherorg/secret-thing"),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    expect(selection.workScopeLeftOut).toBeUndefined();
    expect(selection.workScopeRecoveryNotes).toBeUndefined();
  });

  it("keeps the pin's way back off the agent's channel", async () => {
    const selection = await runStep({
      repositories: LISTED,
      enabledKeys: ENABLED,
      repositoryScope: PINNED_TO_WEB,
      ticket: ticketNaming("acme/docs has the other half of this"),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    const addition = selection.promptAdditions?.find(
      (entry_) => entry_.title === "Repositories left out",
    );
    expect(addition?.content).toContain(OUTSIDE_THE_PIN);
    // Rule 7: the agent reads what the workspace holds, never the lever that
    // would change it.
    expect(JSON.stringify(selection.promptAdditions ?? [])).not.toContain(
      "until that limit changes",
    );
  });

  it("writes nothing to the record about it", async () => {
    const selection = await runStep({
      repositories: LISTED,
      enabledKeys: ENABLED,
      repositoryScope: PINNED_TO_WEB,
      ticket: ticketNaming("acme/docs has the other half of this"),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    // Both halves, because either alone passes on a run that says nothing.
    expect(selection.workScopeLeftOut).toEqual([
      { repositoryKey: "github:acme/docs", reason: OUTSIDE_THE_PIN },
    ]);
    expect(JSON.stringify(appliedPlans())).not.toContain("github:acme/docs");
  });
});

/**
 * The third bound, and the one that looks most like a bug to the person who
 * named it: the repository IS enabled here, so nothing on their side explains
 * why the work came back without it. The provider offers nothing checkoutable
 * for it, which is a durable fact it reported on a listing that SUCCEEDED
 * (archived, or no default branch), never a provider that failed: a provider
 * that fails contributes no repositories at all and has its own sentence.
 */
describe("a repository the catalog enables and no run can check out", () => {
  const ARCHIVED = { ...repo("acme/ops"), archived: true };
  const NO_DEFAULT_BRANCH = repo("acme/docs", "");
  const NO_ANSWER: PreSandboxStepContext["workScope"] = {
    subjectKey: SUBJECT,
    scope: scope([]),
    selectionAnswered: false,
    answeredRepositoryKeys: [],
  };
  const ticketNaming = (comment: string) => ({
    identifier: "AWT-402",
    title: "Invoices are wrong",
    description: "Fix the billing callback in acme/web.",
    acceptanceCriteria: "",
    comments: [
      { author: "Ada", accountId: "human-1", body: comment, createdAt: "2026-09-18T08:00:00.000Z" },
    ],
    labels: [] as string[],
  });
  const run = async (
    listed: RepositoryMetadata[],
    comment: string,
    repositoryScope?: PreSandboxStepContext["repositoryScope"],
  ) =>
    runStep({
      repositories: listed,
      enabledKeys: listed.map((listing) => `github:${listing.repoPath}`),
      ...(repositoryScope ? { repositoryScope } : {}),
      ticket: ticketNaming(comment),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });
  const CANNOT_SERVE = (key: string) =>
    `The catalog cannot serve ${key} at the moment, so no run can use it until it can.`;
  // What is actually true: the repository is on the catalog, it is enabled, and
  // the provider offers nothing to check out for it.
  const UNSERVABLE = (key: string) =>
    `${key} is enabled here, and this run could not check it out:` +
    ` the provider listed it as archived, or offered no default branch for it,` +
    ` so the run started without it.`;

  it("names an archived repository the ticket asked for, instead of dropping it in silence", async () => {
    const selection = await run([repo("acme/web"), ARCHIVED], "acme/ops has the other half");

    expect(selection.status).toBe("continue");
    expect(selection.selectedRepositories?.map((chosen) => chosen.repoPath)).toEqual([
      "acme/web",
    ]);
    expect(selection.workScopeLeftOut).toEqual([
      { repositoryKey: "github:acme/ops", reason: UNSERVABLE("github:acme/ops") },
    ]);
    expect(selection.workScopeRecoveryNotes).toContain(CANNOT_SERVE("github:acme/ops"));
    // The two sentences land in ONE comment, so they may not contradict each
    // other. "Not on the catalog this run may use" is false about a repository
    // that is enabled and sitting on the Repositories page looking fine, and it
    // is the half that reaches the agent's prompt and the memory file.
    expect(JSON.stringify(selection.workScopeLeftOut)).not.toContain(
      "not on the repository catalog",
    );
  });

  it("names one with no default branch the same way, because the person's question is the same", async () => {
    const selection = await run(
      [repo("acme/web"), NO_DEFAULT_BRANCH],
      "acme/docs has the other half",
    );

    expect(selection.workScopeLeftOut).toEqual([
      { repositoryKey: "github:acme/docs", reason: UNSERVABLE("github:acme/docs") },
    ]);
    expect(selection.workScopeRecoveryNotes).toContain(CANNOT_SERVE("github:acme/docs"));
  });

  it("says one line about a repository that is both unusable and outside the pin, and it is the one that would still stand", async () => {
    const selection = await run(
      [repo("acme/web"), NO_DEFAULT_BRANCH],
      "acme/docs has the other half",
      { repositories: [{ provider: "github" as const, repoPath: "acme/web" }] },
    );

    expect(selection.workScopeLeftOut).toHaveLength(1);
    // Widening the pin would not give this person their repository, so the pin
    // is not what they are told about.
    expect(selection.workScopeRecoveryNotes).toContain(CANNOT_SERVE("github:acme/docs"));
    expect(JSON.stringify(selection.workScopeRecoveryNotes ?? [])).not.toContain(
      "limited to a fixed set",
    );
  });

  it("does not send a person to enable a repository that is disabled AND archived", async () => {
    // Both bounds are true. The one that would still stand after the other
    // moved is the archive, so enabling it on the Repositories page costs that
    // person a round and the next run tells them the catalog cannot serve it.
    const selection = await runStep({
      repositories: [repo("acme/web"), ARCHIVED],
      enabledKeys: ["github:acme/web"],
      ticket: ticketNaming("acme/ops has the other half"),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    expect(selection.workScopeLeftOut).toEqual([
      { repositoryKey: "github:acme/ops", reason: UNSERVABLE("github:acme/ops") },
    ]);
    expect(JSON.stringify(selection.workScopeRecoveryNotes ?? [])).not.toContain(
      "Repositories page",
    );
  });

  it("names an archived GITLAB repository, which the listing could not report until it stopped asking for the reduced entity", async () => {
    // The end of the chain the adapter change exists for: GitLab's simple
    // listing carries no archived flag, so this repository counted as usable,
    // a run would have selected it and failed on push, and the person would
    // never have read the word archived anywhere.
    const gitlabOps = {
      ...repo("acme/ops"),
      provider: "gitlab" as const,
      archived: true,
    };
    const selection = await runStep({
      repositories: [repo("acme/web"), gitlabOps],
      enabledKeys: ["github:acme/web", "gitlab:acme/ops"],
      ticket: ticketNaming("the other half is in gitlab:acme/ops"),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    expect(selection.workScopeLeftOut).toEqual([
      { repositoryKey: "gitlab:acme/ops", reason: UNSERVABLE("gitlab:acme/ops") },
    ]);
  });

  it("says nothing about the archived repositories nobody named", async () => {
    // A catalog full of archived rows is ordinary, and a run that listed them
    // all as left out would bury the one line that matters under them.
    const selection = await run(
      [repo("acme/web"), ARCHIVED, NO_DEFAULT_BRANCH],
      "no repository here",
    );

    expect(selection.workScopeLeftOut).toBeUndefined();
    expect(
      selection.promptAdditions?.find((addition) => addition.title === "Repositories left out"),
    ).toBeUndefined();
  });

  it("keeps the way back off the agent's channel and writes nothing to the record", async () => {
    const selection = await run([repo("acme/web"), ARCHIVED], "acme/ops has the other half");

    const addition = selection.promptAdditions?.find(
      (entry_) => entry_.title === "Repositories left out",
    );
    expect(addition?.content).toContain("github:acme/ops");
    expect(JSON.stringify(selection.promptAdditions ?? [])).not.toContain("cannot serve");
    expect(JSON.stringify(appliedPlans())).not.toContain("github:acme/ops");
  });
});

/**
 * Production, 18.09. A ticket whose first sentence names a repository, a person
 * who had excluded exactly that repository through the record, and a run that
 * asked "Which repository or repositories should this ticket inspect or
 * modify?" and said nothing else. The exclusion held, which is right; the
 * question read as though the ticket had never been opened, which is the half
 * this fixes. The cause is upstream of every sentence: `decidableKeys` drops an
 * excluded key before any event proposes it, so the refusal that names the
 * author and the date never happens.
 */
describe("the ticket names a repository a person excluded, and the run has nothing else", () => {
  const DEMO = "github:blazity/ai-workflow-demo";
  const EXCLUDED_BY_ADA = entry({
    repositoryKey: DEMO,
    state: "excluded",
    origin: "person",
    rationale: "not this one",
  });
  const TICKET_NAMING_DEMO = {
    identifier: "AWT-402",
    title: "Fix the typo",
    description: "Fix the typo in README.md of blazity/ai-workflow-demo",
    acceptanceCriteria: "",
    comments: [],
    labels: [] as string[],
  };
  const LISTED = [repo("blazity/ai-workflow-demo"), repo("acme/web")];
  const runExcluded = async (overrides: Parameters<typeof runStep>[0] = {}) =>
    runStep({
      repositories: LISTED,
      enabledKeys: LISTED.map((listed) => `github:${listed.repoPath}`),
      ticket: TICKET_NAMING_DEMO,
      botAccountId: "bot-account",
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([EXCLUDED_BY_ADA]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
      ...overrides,
    });
  const EXCLUSION_SENTENCE =
    `${DEMO} was excluded on this work by Ada on 2026-09-15, so the run started without it.`;

  it("says which repository was excluded, by whom and when, instead of asking as if the ticket were empty", async () => {
    const result = await runExcluded();

    // The record half is untouched: the exclusion still holds and the run still
    // takes nothing from the ticket's text.
    expect(result.selectedRepositories ?? []).toEqual([]);
    expect(result.workScopeLeftOut).toEqual([
      { repositoryKey: DEMO, reason: EXCLUSION_SENTENCE },
    ]);
  });

  it("puts that sentence in front of the question the person actually reads", async () => {
    const { executePreSandboxPhase } = await import("../../engine/steps/pre-sandbox-runner.js");
    const selection = await runExcluded();

    const phase = await executePreSandboxPhase(
      {
        ticket: { identifier: "AWT-402" },
        run: { branchName: "blazebot/awt-402" },
        repositoryAccess: {
          activated: true,
          enabledKeys: LISTED.map((listed) => `github:${listed.repoPath}`),
        },
        settings: testSettingsSnapshot(),
      },
      { preSandbox: { steps: [{ uses: "repo-selection", onFailure: "fail" }] } },
      { "repo-selection": async () => selection },
    );

    // The question is raised by the workspace block, which leads with the
    // refusals the pre-sandbox carried (`askWithWorkScopeRefusals`). Without a
    // refusal to lead with, that question is the whole comment, which is what
    // the person read in production.
    expect(phase.workScopeLeftOut).toEqual([
      { repositoryKey: DEMO, reason: EXCLUSION_SENTENCE },
    ]);
    expect(phase.workScopeRecoveryNotes).toContain(
      "Excluding a repository is not final: this work's repository list can be changed" +
        " through the work scope API or the work_scope.edit tool," +
        " and the next run starts from the changed list.",
    );
  });

  it("keeps the way back out of the questions array, which becomes the agent's memory", async () => {
    const result = await runExcluded();

    // Rule 7, and here it is not theoretical: a clarification round is rendered
    // verbatim into the prompts and written to the memory file under "Human
    // decisions", so a lever put in a question comes back signed by a person.
    // Asserted over the WHOLE result minus the person's own field, so a way back
    // that reappears in a question, a message or a prompt addition is caught
    // wherever it lands rather than only where this test thought to look.
    const said = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    const recovery = said.workScopeRecoveryNotes;
    delete said.workScopeRecoveryNotes;
    expect(JSON.stringify(said)).not.toContain("not final");
    expect(JSON.stringify(recovery ?? [])).toContain("not final");
  });

  it("says nothing about exclusions the ticket does not name", async () => {
    // The record is not a history lesson: an old exclusion for a repository
    // this ticket never mentions stays where it is.
    const result = await runExcluded({
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({
            repositoryKey: "github:acme/web",
            state: "excluded",
            origin: "person",
            rationale: "old news",
          }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(JSON.stringify(result.workScopeLeftOut ?? [])).not.toContain("github:acme/web");
  });

  it("says it although the run found another repository to work in", async () => {
    // Run 1 answered "use acme/web", somebody excluded the demo repository
    // afterwards, and the ticket still names it. The run has a workspace, so
    // nothing about it being empty is true, and the person still needs to know
    // that their own decision is why the pull request covers half the ticket.
    const result = await runStep({
      repositories: [...LISTED],
      enabledKeys: LISTED.map((listed) => `github:${listed.repoPath}`),
      ticket: {
        ...TICKET_NAMING_DEMO,
        description: "Fix the typo in README.md of blazity/ai-workflow-demo and in acme/web",
      },
      botAccountId: "bot-account",
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({ repositoryKey: "github:acme/web" }),
          EXCLUDED_BY_ADA,
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.selectedRepositories?.map((chosen) => chosen.repoPath)).toContain("acme/web");
    expect(result.workScopeLeftOut).toEqual([
      { repositoryKey: DEMO, reason: EXCLUSION_SENTENCE },
    ]);
  });

  it("says it once, not once precisely and once vaguely", async () => {
    const result = await runExcluded();

    // Both sentences used to land in `recorder.notes`, which is joined into the
    // first question: the person read the exclusion naming Ada and the date,
    // then a vaguer restatement of the same fact, then the question.
    const said = JSON.stringify(result);
    expect(said).toContain("was excluded on this work by Ada");
    expect(said).not.toContain("could take none of them");
  });

  it("writes nothing to the record for saying it", async () => {
    const result = await runExcluded();

    expect(result.workScopeLeftOut).toEqual([
      { repositoryKey: DEMO, reason: EXCLUSION_SENTENCE },
    ]);
    // Nothing was decided here: the decision was the person's, months ago, and
    // this run only repeated it back to them.
    expect(appliedTrail()).toEqual([]);
    expect(JSON.stringify(appliedPlans().flatMap((plan) => plan.upserts))).not.toContain(DEMO);
  });
});

/**
 * The hole a provider pin opens, which is the commoner pin shape. Pinning to
 * providers stops the run QUERYING the others (`listedVcsProviders`), so a
 * repository on an unqueried provider is in no listing and therefore in none of
 * the three sets built from one. A person names it, the run works in the
 * repositories it did find, opens a pull request covering half the work and
 * finishes green with nothing said: the founding complaint of this delivery,
 * arriving through the reason added to end it.
 */
describe("a repository on a provider this workflow's pin excludes", () => {
  const GITHUB_ONLY = { providers: ["github" as const] };
  const NO_ANSWER: PreSandboxStepContext["workScope"] = {
    subjectKey: SUBJECT,
    scope: scope([]),
    selectionAnswered: false,
    answeredRepositoryKeys: [],
  };
  const ticketNaming = (description: string) => ({
    identifier: "AWT-402",
    title: "Invoices are wrong",
    description,
    acceptanceCriteria: "",
    comments: [],
    labels: [] as string[],
  });
  const OUTSIDE_THE_PIN =
    "gitlab:acme/ops is outside the repositories the workflow that runs this work may take," +
    " so the run started without it.";

  it("names it from the key alone, without querying the provider the pin excludes", async () => {
    const selection = await runStep({
      // The listing holds GitHub only, exactly as production does under this
      // pin: the GitLab directory is never called.
      repositories: [repo("acme/web")],
      enabledKeys: ["github:acme/web"],
      repositoryScope: GITHUB_ONLY,
      ticket: ticketNaming("Fix the billing callback in acme/web. The other half is in gitlab:acme/ops."),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    expect(selection.selectedRepositories?.map((chosen) => chosen.repoPath)).toEqual([
      "acme/web",
    ]);
    expect(selection.workScopeLeftOut).toEqual([
      { repositoryKey: "gitlab:acme/ops", reason: OUTSIDE_THE_PIN },
    ]);
  });

  it("stays silent about a path that names no provider, because that is a guess", async () => {
    const selection = await runStep({
      repositories: [repo("acme/web")],
      enabledKeys: ["github:acme/web"],
      repositoryScope: GITHUB_ONLY,
      // "acme/ops" alone says nothing about which provider it is on, so this
      // run cannot know it is outside the pin rather than simply unlisted.
      ticket: ticketNaming("Fix the billing callback in acme/web. The other half is in acme/ops."),
      botAccountId: "bot-account",
      workScope: NO_ANSWER,
    });

    expect(selection.workScopeLeftOut).toBeUndefined();
  });
});

/**
 * Label routing memory on a subject that carries a record.
 *
 * The step consults it only on the way to discovery, which is where a person
 * would otherwise be asked, and it decides the remembered repository through the
 * record like any derived key. The tests without a record live in
 * `repo-selection.test.ts`; these hold what the record adds.
 */
describe("what a remembered routing answer may decide on a subject with a record", () => {
  const ROUTING = { ENABLE_REPO_MEMORY: true, ENABLE_REPO_ROUTING_MEMORY: true };
  // Confirmed by two distinct tickets, so it is eligible to select.
  const ROUTING_BODY = "- billing -> github:acme/api (tickets: AIW-1, AIW-7)\n";
  const REMEMBERS_API = {
    content: `# Repo routing: acme\n<!-- blazebot:repo-routing v1 -->\n\n${ROUTING_BODY}`,
    bytes: ROUTING_BODY.length,
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    sourceRunId: "presandbox:blazebot/aiw-7",
    version: 3,
  };
  const FIVE_NAMED = "Touches acme/web, acme/api, acme/docs, acme/infra and acme/ops in one go.";
  /** The which-of-these question named all five, and the answer named none. */
  const FIVE_KEYS = [
    "github:acme/api",
    "github:acme/docs",
    "github:acme/infra",
    "github:acme/ops",
    "github:acme/web",
  ];
  const notNamed = (repositoryKey: string) =>
    `${repositoryKey} was listed in a repository question already answered on this work` +
    " and is not selected on it, so the run started without it.";
  const API_NOT_NAMED = notNamed("github:acme/api");
  /** What a run on this ticket says it left out once the answer named none of
   *  the five, in the order the ticket names them. Since joint gate round 3, R5,
   *  the question being silenced no longer hides them from the comment a
   *  finished run posts (row C10); before, only the repository the remembered
   *  answer proposed was listed. */
  const leftOutOfTheAnswer = (keys: string[]) =>
    keys.map((repositoryKey) => ({ repositoryKey, reason: notNamed(repositoryKey) }));
  const TICKET_ORDER = [
    "github:acme/web",
    "github:acme/api",
    "github:acme/docs",
    "github:acme/infra",
    "github:acme/ops",
  ];
  /** The way back while the ticket's text is still read: both doors. */
  const WAY_BACK_BOTH =
    "Leaving a repository out of an answer is not final: this work's repository list can be" +
    " changed through the work scope API or the work_scope.edit tool, or the repository's full" +
    " path can be written in a ticket comment, as github:acme/api, and the next run reads both.";
  /** The way back once a question named more than three: the record alone,
   *  because a path in a comment is not taken there (rule 6). */
  const WAY_BACK_RECORD_ONLY =
    "Leaving a repository out of an answer is not final: this work's repository list can be" +
    " changed through the work scope API or the work_scope.edit tool, and the next run starts" +
    " from the changed list.";
  const LABELLED = {
    identifier: "AWT-402",
    title: "Invoices are wrong",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    labels: ["billing"],
  };

  // The control for every case below: the document is read, parsed and acted on.
  // Recorded as `inferred`, the lowest origin, because it is a guess learned
  // across tickets: written as anything higher it would seed every later run
  // and, as `person`, silence the only question a person hears on this work.
  it("stands in for the question on a subject nothing was decided on, and records a guess", async () => {
    mocks.getMemoryDocument.mockResolvedValue(REMEMBERS_API);

    const result = await runStep({
      settings: ROUTING,
      ticket: LABELLED,
      workScope: { subjectKey: SUBJECT, scope: null, selectionAnswered: false, answeredRepositoryKeys: [] },
    });

    expect(mocks.getMemoryDocument).toHaveBeenCalledWith("org:github:acme", "routing");
    expect(result.status).toBe("continue");
    expect(result.repositoryDiscovery).toBeUndefined();
    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/api",
    ]);
    const written = appliedTrail().flatMap((event) =>
      event.kind === "entry_written" ? [event.entry] : [],
    );
    expect(
      written.map((each) => [each.repositoryKey, each.state, each.origin, each.rationale]),
    ).toEqual([
      [
        "github:acme/api",
        "selected",
        "inferred",
        "A remembered routing answer for this ticket's labels.",
      ],
    ]);
  });

  it("leaves out a remembered repository a person excluded, and carries on to discovery without it", async () => {
    mocks.getMemoryDocument.mockResolvedValue(REMEMBERS_API);

    const result = await runStep({
      settings: ROUTING,
      ticket: LABELLED,
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([entry({ repositoryKey: "github:acme/api", state: "excluded" })]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    // Read, so the refusal below is the record's and not a missing document.
    expect(mocks.getMemoryDocument).toHaveBeenCalled();
    expect(result.status).toBe("continue");
    expect(result.selectedRepositories).toBeUndefined();
    expect(result.repositoryDiscovery).toBeDefined();
  });

  // Discovery carries what the selection already holds as mandatory, and the
  // remembered answer returns a selection of its own instead of discovery. So a
  // remembered answer read on a run that already held a repository would drop
  // that repository from the run. It is never read there.
  it("is never read when the record already put a person's repository in the workspace", async () => {
    mocks.getMemoryDocument.mockResolvedValue(REMEMBERS_API);

    const result = await runStep({
      settings: ROUTING,
      ticket: LABELLED,
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([entry({ repositoryKey: "github:acme/web" })]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
    ]);
    expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
  });

  // Row A7: a person who answers "none" to the which-of-these question declined
  // the names they saw, and that answer writes no entry. A remembered routing
  // answer is a guess, so it may not take one of those names back for them.
  it("does not attach a repository the person was shown in the which-of-these question and did not name", async () => {
    mocks.getMemoryDocument.mockResolvedValue(REMEMBERS_API);

    const result = await runStep({
      settings: ROUTING,
      ticket: { ...LABELLED, description: FIVE_NAMED },
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([]),
        selectionAnswered: true,
        answeredRepositoryKeys: FIVE_KEYS,
      },
    });

    expect(result.workScopeAsk).toBeUndefined();
    expect(result.status).toBe("continue");
    expect(result.selectedRepositories).toBeUndefined();
    expect(result.repositoryDiscovery).toBeDefined();
    expect(result.workScopeLeftOut).toEqual(leftOutOfTheAnswer(TICKET_ORDER));
    // The question named five, so the comment door is not offered.
    expect(result.workScopeRecoveryNotes).toEqual([WAY_BACK_RECORD_ONLY]);
    const addition = result.promptAdditions?.find(
      (each) => each.title === "Repositories left out",
    );
    expect(addition?.content).toContain(API_NOT_NAMED);
    expect(JSON.stringify(result.promptAdditions ?? [])).not.toContain("work_scope.edit");
  });

  // Skeptic 7: the only-accessible shortcut is a guess about the whole catalog,
  // not a person's choice, so it is bound by the same answer.
  it("does not take the only repository this run can reach when the answer left it unnamed", async () => {
    const result = await runStep({
      repositories: [repo("acme/api")],
      enabledKeys: ["github:acme/api"],
      botAccountId: "bot-account",
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([]),
        selectionAnswered: true,
        answeredRepositoryKeys: ["github:acme/api"],
        answeredAtByKey: { "github:acme/api": "2026-09-16T09:00:00.000Z" },
      },
    });

    expect(result.workScopeAsk).toBeUndefined();
    expect(result.selectedRepositories).toBeUndefined();
    expect(result.repositoryDiscovery).toBeDefined();
    expect(result.workScopeLeftOut).toEqual([
      { repositoryKey: "github:acme/api", reason: API_NOT_NAMED },
    ]);
    // The ticket names nothing, this run can tell a person's comment from ours
    // and knows when the answer landed, so a comment written now is read and
    // taken: both doors are real.
    expect(result.workScopeRecoveryNotes).toEqual([WAY_BACK_BOTH]);
  });

  // Joint gate F3. Every condition the comment door depends on, taken away one
  // at a time. Each one makes the run read every comment as older than the
  // answer, so a sentence promising the comment would send the person through a
  // door the run then ignores. The record is the only door offered.
  it.each([
    [
      "the bot's own account is unknown",
      { botAccountId: undefined, answeredAtByKey: { "github:acme/api": "2026-09-16T09:00:00.000Z" } },
    ],
    ["the answer's instant was never frozen", { botAccountId: "bot-account", answeredAtByKey: undefined }],
    ["the answer's instant cannot be read", { botAccountId: "bot-account", answeredAtByKey: { "github:acme/api": "not a time" } }],
  ])("offers only the record when %s", async (_case, facts) => {
    const result = await runStep({
      repositories: [repo("acme/api")],
      enabledKeys: ["github:acme/api"],
      ...(facts.botAccountId ? { botAccountId: facts.botAccountId } : {}),
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([]),
        selectionAnswered: true,
        answeredRepositoryKeys: ["github:acme/api"],
        ...(facts.answeredAtByKey ? { answeredAtByKey: facts.answeredAtByKey } : {}),
      },
    });

    expect(result.workScopeLeftOut).toEqual([
      { repositoryKey: "github:acme/api", reason: API_NOT_NAMED },
    ]);
    expect(result.workScopeRecoveryNotes).toEqual([WAY_BACK_RECORD_ONLY]);
  });

  // Skeptic 1: the run that asked is the run that resumes, and its frozen copy
  // predates the answer. What it re-reads has to include the answered set, or
  // the very run a person just answered takes back what they left out.
  it("honours the answer in the same run that asked, once it wakes", async () => {
    mocks.getMemoryDocument.mockResolvedValue(REMEMBERS_API);
    mocks.readWorkScope.mockResolvedValue(scope([]));
    mocks.readSelectionAnswered.mockResolvedValue(true);
    mocks.readAnsweredKeys.mockResolvedValue(FIVE_KEYS);

    const result = await runStep({
      settings: ROUTING,
      ticket: { ...LABELLED, description: FIVE_NAMED },
      clarification: { answer: "none", resolves: "repository_selection" },
      workScope: {
        subjectKey: SUBJECT,
        scope: null,
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(mocks.readAnsweredKeys).toHaveBeenCalledWith(SUBJECT);
    expect(result.workScopeAsk).toBeUndefined();
    expect(result.selectedRepositories).toBeUndefined();
    expect(result.workScopeLeftOut).toEqual(leftOutOfTheAnswer(TICKET_ORDER));
  });

  // The deploy window. A run suspended across the deploy that added the answered
  // set replays a frozen context WITHOUT the field, and a missing set is not an
  // empty one: empty says nobody was asked, missing says this run cannot tell.
  // Read as empty it hands the repository somebody declined straight back to the
  // first signal that names it, on the one run nobody can see the difference on.
  it("reads the record again when its frozen context predates the answered set", async () => {
    mocks.getMemoryDocument.mockResolvedValue(REMEMBERS_API);
    mocks.readWorkScope.mockResolvedValue(scope([]));
    mocks.readSelectionAnswered.mockResolvedValue(true);
    mocks.readAnsweredKeys.mockResolvedValue(FIVE_KEYS);

    const result = await runStep({
      settings: ROUTING,
      ticket: { ...LABELLED, description: FIVE_NAMED },
      // No clarification woke this run, and the frozen copy carries no answered
      // set at all: this is the shape of a context written by the deployment
      // before it existed.
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([]),
        selectionAnswered: true,
      },
    });

    expect(mocks.readAnsweredKeys).toHaveBeenCalledWith(SUBJECT);
    expect(result.selectedRepositories).toBeUndefined();
    expect(result.workScopeLeftOut).toEqual(leftOutOfTheAnswer(TICKET_ORDER));
  });

  // The control: a run that DID freeze the set reads its own copy, because a
  // second read would be a second truth in the middle of one run.
  it("uses the frozen answered set without going back to the store", async () => {
    mocks.getMemoryDocument.mockResolvedValue(REMEMBERS_API);

    const result = await runStep({
      settings: ROUTING,
      ticket: { ...LABELLED, description: FIVE_NAMED },
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([]),
        selectionAnswered: true,
        answeredRepositoryKeys: [],
      },
    });

    expect(mocks.readAnsweredKeys).not.toHaveBeenCalled();
    // Nothing was answered as far as this run can see, so the guess stands.
    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/api",
    ]);
  });

  // The way back through the record: a person's selection made after the answer
  // is a person's decision, and the run takes it whatever the answer said.
  it("takes the repository once a person has selected it after leaving it unnamed", async () => {
    mocks.getMemoryDocument.mockResolvedValue(REMEMBERS_API);

    const result = await runStep({
      settings: ROUTING,
      ticket: { ...LABELLED, description: FIVE_NAMED },
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([entry({ repositoryKey: "github:acme/api", rationale: "after all" })]),
        selectionAnswered: true,
        answeredRepositoryKeys: FIVE_KEYS,
      },
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/api",
    ]);
    // acme/api is the person's own now. The other four are still ones the
    // answer left unnamed, and the finished run says so (R5).
    expect(result.workScopeLeftOut).toEqual(
      leftOutOfTheAnswer(TICKET_ORDER.filter((key) => key !== "github:acme/api")),
    );
  });

  // Rules 3 and 6: a full path somebody typed AFTER answering is that person
  // naming the repository, not a guess, and a comment is the way back that works
  // from the ticket. The run has to be able to date it and to tell the person's
  // comment from our own, which is what the two fields beside the answered set
  // are for.
  it("takes a repository whose full path a person wrote in a comment after leaving it unnamed", async () => {
    const result = await runStep({
      ticket: {
        ...LABELLED,
        comments: [
          {
            author: "Ada",
            accountId: "human-1",
            body: "On second thought, use github:acme/api.",
            createdAt: "2026-09-17T09:00:00.000Z",
          },
        ],
      },
      botAccountId: "bot-account",
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([]),
        selectionAnswered: true,
        answeredRepositoryKeys: FIVE_KEYS,
        answeredAtByKey: Object.fromEntries(
          FIVE_KEYS.map((key) => [key, "2026-09-16T09:00:00.000Z"]),
        ),
      },
    });

    expect(result.workScopeAsk).toBeUndefined();
    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/api",
    ]);
  });

  // Skeptic 12: a workflow-owned branch is not a guess. Dropping it strands the
  // open pull request on it, whatever an earlier answer said.
  it("keeps a workflow-owned branch on a repository the answer left unnamed", async () => {
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValue([
      {
        ticketKey: "AWT-402",
        provider: "github",
        repoPath: "acme/api",
        branchName: "blazebot/awt-402",
        pr: null,
      },
    ]);

    const result = await runStep({
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([]),
        selectionAnswered: true,
        answeredRepositoryKeys: FIVE_KEYS,
      },
    });

    expect(result.selectedRepositories).toEqual([
      expect.objectContaining({
        repoPath: "acme/api",
        selectedRationale: "workflow-owned branch for this ticket",
      }),
    ]);
  });

  // RULE 6 ON THE CASE THE COMMENT DOOR DOES NOT OPEN. The ticket that raised
  // the which-of-these question still names five repositories, so after the
  // answer nothing is taken from its text, a path written in a comment included.
  // The way back therefore names the record alone and never sends the person to
  // write a comment that nothing reads.
  it("offers only the record as the way back while the ticket names more than three, and takes no path from a comment", async () => {
    mocks.getMemoryDocument.mockResolvedValue(REMEMBERS_API);

    const result = await runStep({
      settings: ROUTING,
      ticket: {
        ...LABELLED,
        description: FIVE_NAMED,
        comments: [
          {
            author: "Ada",
            accountId: "human-1",
            body: "Use github:acme/api.",
            createdAt: "2026-09-17T09:00:00.000Z",
          },
        ],
      },
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([]),
        selectionAnswered: true,
        answeredRepositoryKeys: FIVE_KEYS,
      },
    });

    // What the run does, which is the fact the sentence has to agree with.
    expect(result.selectedRepositories).toBeUndefined();
    expect(result.workScopeRecoveryNotes).toEqual([WAY_BACK_RECORD_ONLY]);
    expect(JSON.stringify(result.workScopeRecoveryNotes)).not.toContain("comment");
  });
});

/**
 * The ticket's own text, after somebody answered the question that text raised.
 *
 * The which-of-these question is asked about the repositories the ticket names,
 * so the ticket goes on naming every one of them after the answer. While there
 * are more than three of them nothing is taken from that text at all, which is
 * the case the tests above hold. These hold what happens when the count DROPS
 * below the ambiguity limit, because a person excluded one or the catalog
 * withdrew it: the text branch runs again, over words that decided nothing the
 * first time.
 */
describe("what the ticket's text may decide after the answer it raised", () => {
  const FOUR_NAMED = "Touches acme/web, acme/api, acme/docs and acme/infra.";
  /** The question named all four, and the answer named acme/web alone. */
  const FOUR_KEYS = [
    "github:acme/api",
    "github:acme/docs",
    "github:acme/infra",
    "github:acme/web",
  ];
  const ANSWERED_AT = "2026-09-16T09:00:00.000Z";
  const BOT = "bot-account";
  const notNamed = (repositoryKey: string) =>
    `${repositoryKey} was listed in a repository question already answered on this work` +
    " and is not selected on it, so the run started without it.";
  /**
   * The ticket names acme/docs in its description and this person excluded it,
   * so every run on this subject says so, by name and by date.
   *
   * It appears in these expectations from the round that made the exclusion
   * report per repository rather than only where the run had nothing else. The
   * fixture always held it; what changed is that the person is now told about
   * their own decision instead of reading a pull request that quietly covers
   * less of the ticket than its text names.
   */
  const excludedDocs = {
    repositoryKey: "github:acme/docs",
    reason:
      "github:acme/docs was excluded on this work by Ada on 2026-09-15," +
      " so the run started without it.",
  };
  const TICKET = {
    identifier: "AWT-402",
    title: "Invoices are wrong",
    description: FOUR_NAMED,
    acceptanceCriteria: "",
    comments: [] as NonNullable<PreSandboxStepContext["ticket"]["comments"]>,
    labels: [] as string[],
  };
  /** Run 1 asked about all four and the person named acme/web; acme/docs was
   *  excluded through the edit surface afterwards, which is what drops the open
   *  matches to three and lets the text branch run at all. */
  const AFTER_THE_ANSWER: PreSandboxStepContext["workScope"] = {
    subjectKey: SUBJECT,
    scope: scope([
      entry({ repositoryKey: "github:acme/web" }),
      entry({
        repositoryKey: "github:acme/docs",
        state: "excluded",
        rationale: "not this one",
      }),
    ]),
    selectionAnswered: true,
    answeredRepositoryKeys: FOUR_KEYS,
    answeredAtByKey: Object.fromEntries(FOUR_KEYS.map((key) => [key, ANSWERED_AT])),
  };

  // THE DEFECT. Four named, one answered, one excluded afterwards: the count of
  // open matches falls to three, the ambiguity gate stops firing, and the text
  // branch attached the two repositories the person had declined and wrote them
  // down as selected, on a record with no undo screen.
  it("attaches nothing new and writes no entry when only the text that raised the question names them", async () => {
    const result = await runStep({
      ticket: TICKET,
      botAccountId: BOT,
      workScope: AFTER_THE_ANSWER,
    });

    expect(result.status).toBe("continue");
    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
    ]);
    expect(appliedPlans().flatMap((plan) => plan.upserts)).toEqual([]);
    expect(appliedTrail()).toEqual([]);
    // Said as a refusal is said, keyed, and with no trail line behind it.
    expect(result.workScopeLeftOut).toEqual([
      excludedDocs,
      { repositoryKey: "github:acme/api", reason: notNamed("github:acme/api") },
      { repositoryKey: "github:acme/infra", reason: notNamed("github:acme/infra") },
    ]);
  });

  // The reviewer's variant of the same defect, through the catalog rather than
  // the edit surface: the question named five, the person named none of them,
  // and two of the five stopped being usable afterwards. The open matches fall
  // to three, so the ambiguity gate stops firing and the text branch runs over
  // the very words the question was asked about.
  it("takes none of the five when two stop being usable and nobody wrote anything since", async () => {
    const FIVE_NAMED_TEXT =
      "Touches acme/web, acme/api, acme/docs, acme/infra and acme/ops.";
    const FIVE_KEYS = [
      "github:acme/api",
      "github:acme/docs",
      "github:acme/infra",
      "github:acme/ops",
      "github:acme/web",
    ];

    const result = await runStep({
      ticket: { ...TICKET, description: FIVE_NAMED_TEXT },
      botAccountId: BOT,
      // Two of the five lost their default branch since the question was put.
      repositories: [
        repo("acme/web"),
        repo("acme/api"),
        repo("acme/docs"),
        repo("acme/infra", ""),
        repo("acme/ops", ""),
      ],
      workScope: {
        subjectKey: SUBJECT,
        scope: null,
        selectionAnswered: true,
        answeredRepositoryKeys: FIVE_KEYS,
        answeredAtByKey: Object.fromEntries(FIVE_KEYS.map((key) => [key, ANSWERED_AT])),
      },
    });

    expect(result.selectedRepositories ?? []).toEqual([]);
    expect(appliedPlans().flatMap((plan) => plan.upserts)).toEqual([]);
    expect(appliedTrail()).toEqual([]);
    expect(result.workScopeLeftOut).toEqual([
      { repositoryKey: "github:acme/web", reason: notNamed("github:acme/web") },
      { repositoryKey: "github:acme/api", reason: notNamed("github:acme/api") },
      { repositoryKey: "github:acme/docs", reason: notNamed("github:acme/docs") },
    ]);
    // Skeptic F1. Three are open now, so this run DOES read the ticket's text,
    // and a path written after the answer would be taken. Telling the person
    // the comment door is shut, because an older question once asked about five,
    // would be false; the sentence counts what this run just counted.
    expect(result.workScopeRecoveryNotes).toEqual([
      "Leaving a repository out of an answer is not final: this work's repository list can be" +
        " changed through the work scope API or the work_scope.edit tool, or the repository's" +
        " full path can be written in a ticket comment, as github:acme/web, and the next run" +
        " reads both.",
    ]);
  });

  // The door the recovery sentence sends people to, and it has to open: a full
  // path typed after the answer is a new decision, so the run takes it and
  // records where it came from.
  it("takes a repository whose full path a person wrote after the answer, and records the text as its origin", async () => {
    const result = await runStep({
      ticket: {
        ...TICKET,
        comments: [
          {
            author: "Ada",
            accountId: "human-1",
            body: "On second thought, use github:acme/api.",
            createdAt: "2026-09-16T10:00:00.000Z",
          },
        ],
      },
      botAccountId: BOT,
      workScope: AFTER_THE_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
      "acme/api",
    ]);
    expect(appliedPlans().flatMap((plan) => plan.upserts)).toEqual([
      {
        entry: expect.objectContaining({
          repositoryKey: "github:acme/api",
          state: "selected",
          origin: "ticket_text",
        }),
        replacesExpired: false,
      },
    ]);
    expect(appliedTrail()).toEqual([
      expect.objectContaining({
        kind: "entry_written",
        entry: expect.objectContaining({ repositoryKey: "github:acme/api" }),
      }),
    ]);
    // Only the one a person named: the other two are still just the ticket's
    // original words.
    expect(result.workScopeLeftOut).toEqual([
      excludedDocs,
      { repositoryKey: "github:acme/infra", reason: notNamed("github:acme/infra") },
    ]);
  });

  // Joint gate F2, the exact order of events. T1: the which-of-these question
  // is answered. T2: the person writes acme/api's path in a comment, as the way
  // back told them to. T3: they answer "none" to an expansion question about a
  // DIFFERENT repository. Dated against the newest answer on the subject, their
  // T2 comment would read as older than an answer and be ignored; dated against
  // the answer that named acme/api, it is theirs and it is taken.
  it("dates a comment against the answer that named the repository, not a later answer about another", async () => {
    const T1 = ANSWERED_AT; // 2026-09-16T09:00
    const T2 = "2026-09-16T10:00:00.000Z";
    const T3 = "2026-09-16T11:00:00.000Z";
    const result = await runStep({
      ticket: {
        ...TICKET,
        comments: [
          { author: "Ada", accountId: "human-1", body: "Use github:acme/api after all.", createdAt: T2 },
        ],
      },
      botAccountId: BOT,
      workScope: {
        ...AFTER_THE_ANSWER,
        answeredRepositoryKeys: [...FOUR_KEYS, "github:acme/ops"],
        answeredAtByKey: {
          ...Object.fromEntries(FOUR_KEYS.map((key) => [key, T1])),
          "github:acme/ops": T3,
        },
      },
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
      "acme/api",
    ]);
    expect(appliedPlans().flatMap((plan) => plan.upserts)).toEqual([
      expect.objectContaining({
        entry: expect.objectContaining({ repositoryKey: "github:acme/api", origin: "ticket_text" }),
      }),
    ]);
  });

  // Joint gate F5. The way back sent this person to write the path, they did,
  // and this run cannot open that repository: it lost its default branch, or the
  // workflow is pinned to others. Taking nothing is right; taking nothing
  // without a word is the silence the record exists to end, because on a run
  // that finishes the line per repository in the analysis comment is the only
  // thing a person reads. Keyed, because that comment renders one line per
  // repository, and with no trail line: nothing was decided about the work.
  it.each([
    [
      "the repository is not usable",
      { repositories: [repo("acme/web"), repo("acme/api", ""), repo("acme/docs"), repo("acme/infra")] },
      // Not "is not on the repository catalog this run may use": api IS on the
      // catalog and enabled, and that sentence sent this person to a page where
      // they would find it switched on, while the remedy in the same comment
      // told them the catalog cannot serve it. One repository, two claims.
      "github:acme/api is enabled here, and this run could not check it out:" +
        " the provider listed it as archived, or offered no default branch for it," +
        " so the run started without it.",
      // S17: the remedy, in the person's channel only.
      "The catalog cannot serve github:acme/api at the moment, so no run can use it until it can.",
    ],
    [
      "the workflow is pinned to other repositories",
      {
        repositoryScope: {
          repositories: [
            { provider: "github" as const, repoPath: "acme/web" },
            { provider: "github" as const, repoPath: "acme/infra" },
          ],
        },
      },
      "github:acme/api is outside the repositories the workflow that runs this work may take," +
        " so the run started without it.",
      "The workflow that runs this work is limited to a fixed set of repositories, which does not" +
        " include github:acme/api, so no run of it can use that repository until that limit changes.",
    ],
  ])("says why it did not take a path written after the answer when %s", async (_, run, reason, remedy) => {
    const result = await runStep({
      ...run,
      ticket: {
        ...TICKET,
        comments: [
          {
            author: "Ada",
            accountId: "human-1",
            body: "On second thought, use github:acme/api.",
            createdAt: "2026-09-16T10:00:00.000Z",
          },
        ],
      },
      botAccountId: BOT,
      workScope: AFTER_THE_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).not.toContain(
      "acme/api",
    );
    expect(
      result.workScopeLeftOut?.filter((left) => left.repositoryKey === "github:acme/api"),
    ).toEqual([{ repositoryKey: "github:acme/api", reason }]);
    expect(result.workScopeRecoveryNotes).toContain(remedy);
    expect(JSON.stringify(result.promptAdditions ?? [])).not.toContain(remedy);
    expect(appliedTrail()).toEqual([]);
  });

  // Joint gate round 3, R9 (the skeptic's probe P5). A repository disabled on
  // the Repositories page is not in the listing this run matches against at
  // all, so the path a person wrote for it after answering was reported
  // nowhere. It is a repository the answer named, so its key is known, and the
  // path is matched against that key.
  it("says why it did not take a path written after the answer for a repository the catalog does not enable", async () => {
    const result = await runStep({
      repositories: ALL.filter((listed) => listed.repoPath !== "acme/ops"),
      enabledKeys: ALL.filter((listed) => listed.repoPath !== "acme/ops").map(
        (listed) => `github:${listed.repoPath}`,
      ),
      ticket: {
        ...TICKET,
        comments: [
          {
            author: "Ada",
            accountId: "human-1",
            body: "Please use github:acme/ops as well.",
            createdAt: "2026-09-16T10:00:00.000Z",
          },
        ],
      },
      botAccountId: BOT,
      workScope: {
        ...AFTER_THE_ANSWER,
        answeredRepositoryKeys: [...FOUR_KEYS, "github:acme/ops"],
        answeredAtByKey: Object.fromEntries(
          [...FOUR_KEYS, "github:acme/ops"].map((key) => [key, ANSWERED_AT]),
        ),
      },
    });

    expect(
      result.workScopeLeftOut?.filter((left) => left.repositoryKey === "github:acme/ops"),
    ).toEqual([
      {
        repositoryKey: "github:acme/ops",
        reason:
          "github:acme/ops is not on the repository catalog this run may use, so the run started without it.",
      },
    ]);
    // S17: who can change that, said to the person and not to the agent.
    const enableIt =
      "github:acme/ops is not enabled on the Repositories page. Somebody with access to that page" +
      " can enable it, and until then no run can use it.";
    expect(result.workScopeRecoveryNotes).toContain(enableIt);
    expect(JSON.stringify(result.promptAdditions ?? [])).not.toContain("Repositories page");
    expect(appliedTrail()).toEqual([]);
  });

  // Joint gate round 3, R10 (the skeptic's probe P9). A comment after the
  // answer that says NOT to touch a repository is not a person naming it: the
  // same negation reading an answer gets decides it, and the repository stays
  // exactly where the answer left it.
  it("does not take a repository a comment after the answer says not to touch", async () => {
    const result = await runStep({
      ticket: {
        ...TICKET,
        comments: [
          {
            author: "Ada",
            accountId: "human-1",
            body: "Please do NOT touch github:acme/api, it is frozen.",
            createdAt: "2026-09-16T10:00:00.000Z",
          },
        ],
      },
      botAccountId: BOT,
      workScope: AFTER_THE_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
    ]);
    expect(appliedPlans().flatMap((plan) => plan.upserts)).toEqual([]);
    // Left where the answer put it, and said so in the words that name the
    // comment, so a misreading is visible to the person who wrote it (S15).
    expect(
      result.workScopeLeftOut?.filter((left) => left.repositoryKey === "github:acme/api"),
    ).toEqual([{ repositoryKey: "github:acme/api", reason: saidNoInAComment("github:acme/api") }]);
  });

  // Joint gate round 3, S15. A comment after the answer that names a path and
  // also says no is read as a whole, and not as naming it: the reader cannot
  // tell "don't touch api, but infra" from "don't touch api or infra". That
  // leaves out a repository the person may have wanted, so the run says so, in
  // the line it writes for that repository, instead of the ordinary sentence
  // that reads as if nobody had written anything since the answer.
  const saidNoInAComment = (repositoryKey: string) =>
    `${repositoryKey} was listed in a repository question already answered on this work and is not` +
    " selected on it, and the newest comment written after that answer that names it also says no," +
    " so the run did not read that comment as naming it and started without it.";
  const commentAt = (body: string, createdAt: string) => ({
    author: "Ada",
    accountId: "human-1",
    body,
    createdAt,
  });

  it.each([
    "Don't touch github:acme/api, but github:acme/infra needs the new client",
    "Nie ruszajcie github:acme/api, za to github:acme/infra trzeba zaktualizować",
  ])("takes neither path from %j, and says why for each", async (body) => {
    const result = await runStep({
      ticket: { ...TICKET, comments: [commentAt(body, "2026-09-16T10:00:00.000Z")] },
      botAccountId: BOT,
      workScope: AFTER_THE_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
    ]);
    expect(appliedPlans().flatMap((plan) => plan.upserts)).toEqual([]);
    expect(result.workScopeLeftOut).toEqual([
      excludedDocs,
      { repositoryKey: "github:acme/api", reason: saidNoInAComment("github:acme/api") },
      { repositoryKey: "github:acme/infra", reason: saidNoInAComment("github:acme/infra") },
    ]);
  });

  // Round 6, R1, and this is the case the round before got wrong. A comment
  // carrying a negation word is not a comment that keeps us out of a repository:
  // "don't forget" asks for the repositories beside it, and reading it as a
  // refusal took BOTH of them off the run and told the person their own comment
  // had said no about the repository they had just asked for.
  it.each([
    "Don't forget: github:acme/infra and github:acme/api need the new endpoint",
    "Don't forget to update github:acme/infra and github:acme/api",
    "Fix the login bug in github:acme/api and github:acme/infra, but do not deploy yet",
    "Napraw logowanie w github:acme/api oraz github:acme/infra, nie wdrażaj jeszcze",
  ])("takes both paths from %j", async (body) => {
    const result = await runStep({
      ticket: { ...TICKET, comments: [commentAt(body, "2026-09-16T10:00:00.000Z")] },
      botAccountId: BOT,
      workScope: AFTER_THE_ANSWER,
    });

    // Written after the answer, so each path is that person naming it (C11g),
    // and nothing is left out to be explained EXCEPT the repository this person
    // excluded, which the ticket still names and which no comment took back.
    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
      "acme/api",
      "acme/infra",
    ]);
    expect(result.workScopeLeftOut ?? []).toEqual([excludedDocs]);
  });

  it("takes the repository when the newest comment about it says to use it", async () => {
    const result = await runStep({
      ticket: {
        ...TICKET,
        comments: [
          commentAt("Please do NOT touch github:acme/api, it is frozen.", "2026-09-16T10:00:00.000Z"),
          commentAt("Changed my mind, github:acme/api is needed after all", "2026-09-17T10:00:00.000Z"),
        ],
      },
      botAccountId: BOT,
      workScope: AFTER_THE_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toContain("acme/api");
  });

  it("does not take the repository when the newest comment about it says no", async () => {
    const result = await runStep({
      ticket: {
        ...TICKET,
        comments: [
          commentAt("github:acme/api is needed after all", "2026-09-16T10:00:00.000Z"),
          commentAt("Actually, do not touch github:acme/api.", "2026-09-17T10:00:00.000Z"),
        ],
      },
      botAccountId: BOT,
      workScope: AFTER_THE_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).not.toContain(
      "acme/api",
    );
    expect(
      result.workScopeLeftOut?.filter((left) => left.repositoryKey === "github:acme/api"),
    ).toEqual([{ repositoryKey: "github:acme/api", reason: saidNoInAComment("github:acme/api") }]);
  });

  // C11r, where the two readings meet. The ticket's own words never named this
  // repository: the only thing that ever did is the comment the run stopped
  // reading, so the reason it is absent is no longer "the ticket names it and
  // the answer bound it". The sentence still names the answer, because the
  // answer is what it is bound by, and the comment, because that is what a
  // person would otherwise think had moved it.
  it("names the answer and the comment for a repository only the unread comment mentions", async () => {
    const result = await runStep({
      ticket: {
        ...TICKET,
        comments: [commentAt("Please do not touch github:acme/ops.", "2026-09-16T10:00:00.000Z")],
      },
      botAccountId: BOT,
      workScope: {
        ...AFTER_THE_ANSWER,
        answeredRepositoryKeys: [...FOUR_KEYS, "github:acme/ops"],
        answeredAtByKey: Object.fromEntries(
          [...FOUR_KEYS, "github:acme/ops"].map((key) => [key, ANSWERED_AT]),
        ),
      },
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).not.toContain(
      "acme/ops",
    );
    expect(
      result.workScopeLeftOut?.filter((left) => left.repositoryKey === "github:acme/ops"),
    ).toEqual([{ repositoryKey: "github:acme/ops", reason: saidNoInAComment("github:acme/ops") }]);
  });

  // The control: a path written BEFORE the answer is the words the question was
  // asked about, already answered for, and gets no second line.
  it("says nothing more about a path that was written before the answer", async () => {
    const result = await runStep({
      repositories: [repo("acme/web"), repo("acme/api", ""), repo("acme/docs"), repo("acme/infra")],
      ticket: {
        ...TICKET,
        comments: [
          {
            author: "Ada",
            accountId: "human-1",
            body: "Maybe github:acme/api too.",
            createdAt: "2026-09-16T08:00:00.000Z",
          },
        ],
      },
      botAccountId: BOT,
      workScope: AFTER_THE_ANSWER,
    });

    expect(
      (result.workScopeLeftOut ?? []).filter((left) => left.repositoryKey === "github:acme/api"),
    ).toEqual([]);
  });

  // Our own question lists the repository keys it asks about, so a comment we
  // wrote would otherwise read as somebody naming every one of them.
  it("does not take a repository whose path only the bot's own comment wrote after the answer", async () => {
    const result = await runStep({
      ticket: {
        ...TICKET,
        comments: [
          {
            author: "AI Workflow",
            accountId: BOT,
            body: "Which of these should this ticket work on: github:acme/api?",
            createdAt: "2026-09-16T10:00:00.000Z",
          },
        ],
      },
      botAccountId: BOT,
      workScope: AFTER_THE_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
    ]);
    expect(appliedPlans().flatMap((plan) => plan.upserts)).toEqual([]);
    expect(result.workScopeLeftOut).toEqual([
      excludedDocs,
      { repositoryKey: "github:acme/api", reason: notNamed("github:acme/api") },
      { repositoryKey: "github:acme/infra", reason: notNamed("github:acme/infra") },
    ]);
  });

  // A person's comment written BEFORE the answer is part of what the question
  // was asked about, so it decides no more than the description does.
  it("does not take a path a person wrote before the answer", async () => {
    const result = await runStep({
      ticket: {
        ...TICKET,
        comments: [
          {
            author: "Ada",
            accountId: "human-1",
            body: "We will probably need github:acme/api.",
            createdAt: "2026-09-15T08:00:00.000Z",
          },
        ],
      },
      botAccountId: BOT,
      workScope: AFTER_THE_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
    ]);
    expect(appliedPlans().flatMap((plan) => plan.upserts)).toEqual([]);
  });

  // A run replaying a run-start result written before the answer could be dated
  // has no instant to compare a comment against, and the safe reading of that is
  // the one that leaves a repository out rather than choosing it for somebody.
  it("takes nothing from a comment when the run froze no answer instant", async () => {
    const { answeredAtByKey: _answeredAtByKey, ...withoutTheInstant } = AFTER_THE_ANSWER;
    const result = await runStep({
      ticket: {
        ...TICKET,
        comments: [
          {
            author: "Ada",
            accountId: "human-1",
            body: "On second thought, use github:acme/api.",
            createdAt: "2026-09-16T10:00:00.000Z",
          },
        ],
      },
      botAccountId: BOT,
      workScope: withoutTheInstant,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
    ]);
    expect(appliedPlans().flatMap((plan) => plan.upserts)).toEqual([]);
  });
});

/**
 * Joint gate round 3, C11r. The negation reading a comment gets after an answer
 * is the reading every comment gets, wherever the ticket's text is assembled.
 *
 * The description and the acceptance criteria are NOT read that way: they are
 * the ticket's own words, the words every question about this work was asked
 * about, and a sentence there saying not to touch a repository is a sentence
 * about the work rather than an instruction aimed at this run.
 *
 * A comment is a person speaking after those words, so "do not touch X" in one
 * is read as it is meant. Whole comment, because the reader cannot tell "not
 * api, but infra" from "not api or infra", which costs the person a comment
 * naming only what to use. Nothing is silenced for it: a repository named in a
 * comment this run did not read is said out loud, with the way back beside it.
 */
describe("a comment that says no names nothing", () => {
  const BOT_HERE = "bot-account";
  const NAMES_WEB = "Fix the billing callback in acme/web.";
  const said = (repositoryKey: string) =>
    `${repositoryKey} is named in a ticket comment that also says no about a repository,` +
    " so the run read nothing from that comment and started without it.";
  const wayBack = (repositoryKey: string) =>
    "A ticket comment brings a repository into this work only when it says no about none of" +
    ` them. To bring ${repositoryKey} in, write a comment naming only the repositories to work` +
    " on, or change this work's repository list through the work scope API or the" +
    " work_scope.edit tool.";
  const ticketWith = (body: string, description = NAMES_WEB) => ({
    identifier: "AWT-402",
    title: "Invoices are wrong",
    description,
    acceptanceCriteria: "",
    comments: [
      { author: "Ada", accountId: "human-1", body, createdAt: "2026-09-16T10:00:00.000Z" },
    ],
    labels: [] as string[],
  });
  const NO_ANSWER: PreSandboxStepContext["workScope"] = {
    subjectKey: SUBJECT,
    scope: scope([]),
    selectionAnswered: false,
    answeredRepositoryKeys: [],
  };

  // The ruling's own example. Nobody has been asked anything here: the comment
  // is the only thing naming either repository, and the old reading attached
  // both, the one the person asked for and the one they refused.
  it("takes neither path from a comment that names one and refuses another, and says why for both", async () => {
    const result = await runStep({
      ticket: ticketWith("Use github:acme/api, do not touch github:acme/infra."),
      botAccountId: BOT_HERE,
      workScope: NO_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
    ]);
    expect(result.workScopeLeftOut).toEqual([
      { repositoryKey: "github:acme/api", reason: said("github:acme/api") },
      { repositoryKey: "github:acme/infra", reason: said("github:acme/infra") },
    ]);
    // Never silence: the sentence a person reads says what to do about it, and
    // the agent's channel never carries a lever (rule 7).
    expect(result.workScopeRecoveryNotes).toContain(wayBack("github:acme/api"));
    expect(JSON.stringify(result.promptAdditions ?? [])).not.toContain("work_scope.edit");
  });

  // The control that proves the negation is what drops the comment, and not
  // the comment being a comment.
  it("takes both paths from the same comment without the refusal", async () => {
    const result = await runStep({
      ticket: ticketWith("Use github:acme/api and github:acme/infra."),
      botAccountId: BOT_HERE,
      workScope: NO_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
      "acme/api",
      "acme/infra",
    ]);
    expect(result.workScopeLeftOut ?? []).toEqual([]);
  });

  // Round 5, S3, and this test changed meaning with the owner's ruling. The
  // ticket's own words used to be exempt from the reading altogether, so
  // "Do NOT touch github:acme/api, it is frozen." attached api and said nothing:
  // the run worked in the one repository the ticket had told it to leave alone,
  // and the only channel that could have caught it was silent. A description is
  // many thoughts rather than one, so it is read a sentence at a time, and the
  // repository is left out and said out loud.
  it("does not take a path the description names only in a sentence that says no", async () => {
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Invoices are wrong",
        description: "Fix the billing callback in acme/web. Do NOT touch github:acme/api, it is frozen.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      botAccountId: BOT_HERE,
      workScope: NO_ANSWER,
    });

    // The sentence beside it still decides, which is why the reading is per
    // sentence and not per ticket.
    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
    ]);
    expect(result.workScopeLeftOut).toEqual([
      {
        repositoryKey: "github:acme/api",
        reason:
          "github:acme/api is named in this ticket only where its text says no about a" +
          " repository, so the run did not take it from the ticket and started without it.",
      },
    ]);
    expect((result.workScopeRecoveryNotes ?? []).join(" ")).toContain(
      "does not bring it into this work",
    );
  });

  // Round 6, R1, on the ticket's own words. The round before read any negation
  // word in the sentence as a refusal of the repositories named in it, which is
  // the most ordinary ticket anybody writes: the work is asked for in one
  // breath and a caution is added in the next. Each of these dropped the
  // repository the ticket is about and told the person, by name, that their own
  // ticket had said no about it.
  it.each([
    "Fix the login bug in github:acme/api, but do not deploy yet.",
    "Don't forget to update github:acme/api.",
    "Never mind the old client, github:acme/api needs the new one.",
    "Use github:acme/api rather than the old service.",
    "Napraw logowanie w github:acme/api, nie wdrażaj jeszcze.",
    "Napraw github:acme/api bez zmiany schematu.",
    // Round 6, the coordinator's ruling on the bare verbs. Each of these tells
    // us what not to do INSIDE the repository it is asking us to work in, which
    // is "do not deploy" wearing a different verb: the verb has to govern the
    // repository, and here it governs a migration, a test and a schema.
    "Skip the migration in github:acme/api.",
    "Ignore the failing test in github:acme/api.",
    "The schema is frozen in github:acme/api.",
    "Pomiń migrację w github:acme/api.",
  ])("takes the repository the description names in %j", async (description) => {
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Invoices are wrong",
        description,
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      botAccountId: BOT_HERE,
      workScope: NO_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/api",
    ]);
    // And nothing is said about it, because nothing was left behind. The
    // sentence that named a repository as refused by its own ticket was the
    // second half of the defect.
    expect(result.workScopeLeftOut ?? []).toEqual([]);
  });

  // Round 6, R1 again, from the other side: the phrasings that really do keep
  // this run out, each sharing a phrase with the path it is about.
  it.each([
    "Fix it. Do not use github:acme/api, it is frozen.",
    "Fix it. Leave github:acme/api out of this.",
    "Fix it. github:acme/api is out of scope.",
    "Fix it. Skip github:acme/api for now.",
    "Napraw to. Nie ruszaj github:acme/api.",
    "Napraw to. Pomiń github:acme/api.",
    "Napraw to bez github:acme/api.",
    // The other half of the same ruling: the verb standing in front of the
    // repository, spelled out or called one.
    "Fix it. Ignore github:acme/api.",
    "Fix it. Skip the repository github:acme/api.",
    "Fix it. github:acme/api is frozen.",
  ])("does not take the repository the description names only in %j", async (description) => {
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Invoices are wrong",
        description,
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      botAccountId: BOT_HERE,
      workScope: NO_ANSWER,
    });

    expect(result.selectedRepositories ?? []).toEqual([]);
    expect(result.workScopeLeftOut?.map((left) => left.repositoryKey)).toEqual([
      "github:acme/api",
    ]);
  });

  // Round 6, R1, the list a person writes when several repositories are out.
  // Each bullet on its own says nothing, so the header has to carry, and it has
  // to stop carrying: the paragraph after the list is not part of it.
  it("carries a list header to its items and no further", async () => {
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Invoices are wrong",
        description: [
          "Do not touch:",
          "- github:acme/api",
          "- github:acme/infra",
          "",
          "The callback lives in github:acme/web.",
        ].join("\n"),
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      botAccountId: BOT_HERE,
      workScope: NO_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
    ]);
    expect(result.workScopeLeftOut?.map((left) => left.repositoryKey)).toEqual([
      "github:acme/api",
      "github:acme/infra",
    ]);
  });

  // Round 6, R2. The two readers used to disagree about what the text IS: the
  // one deciding whether the words said no dropped quoted lines and the one
  // finding paths did not, so this description disarmed the refusal on one side
  // and matched the path on the other, and the run cloned the repository the
  // ticket had told it to leave alone.
  it("does not take a path a quoted line of the description refuses", async () => {
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Invoices are wrong",
        description:
          "Fix the billing callback in acme/web.\n> Do NOT touch github:acme/api, it is frozen.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      botAccountId: BOT_HERE,
      workScope: NO_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
    ]);
  });

  // Round 6, R3. Our own sentence, quoted back with an "agreed" under it, is
  // not that person naming the repository: the key in it is ours. The scan that
  // found paths in a comment read the comment raw, so agreeing with a sentence
  // about a repository this work left out attached it.
  it("does not take a path a person only quoted from our own comment", async () => {
    const result = await runStep({
      ticket: ticketWith(
        "> github:acme/api was left out of this work and the run started without it.\nagreed",
      ),
      botAccountId: BOT_HERE,
      workScope: NO_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
    ]);
    // Nothing was refused either: they quoted us, and a quote decides nothing
    // in either direction.
    expect(result.workScopeLeftOut ?? []).toEqual([]);
  });

  // The control: the same words, a sentence apart. A description that refuses
  // one repository must not drop every other repository it names, which is what
  // reading the ticket whole would do.
  it("takes a path a different sentence of the description names", async () => {
    const result = await runStep({
      ticket: {
        identifier: "AWT-402",
        title: "Invoices are wrong",
        description:
          "Do NOT touch github:acme/api, it is frozen.\nThe callback lives in github:acme/infra.",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
      },
      botAccountId: BOT_HERE,
      workScope: NO_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/infra",
    ]);
  });

  // A repository already in the record is not removed by a comment. The record
  // is what the work IS; a comment this run declined to read is not evidence
  // that went away, and deleting the entry would take the repository off every
  // later run with nobody's decision behind it.
  it("keeps a recorded entry whose only remaining mention is in a comment that says no", async () => {
    const result = await runStep({
      ticket: ticketWith("Please do not touch github:acme/api this week.", "Invoices are wrong."),
      botAccountId: BOT_HERE,
      workScope: {
        subjectKey: SUBJECT,
        scope: scope([
          entry({
            repositoryKey: "github:acme/api",
            origin: "ticket_text",
            rationale: "the ticket text names this repository path",
          }),
        ]),
        selectionAnswered: false,
        answeredRepositoryKeys: [],
      },
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/api",
    ]);
    expect(
      appliedPlans().flatMap((plan) =>
        plan.deletes.filter((deletion) => deletion.repositoryKey === "github:acme/api"),
      ),
    ).toEqual([]);
    // Taken, so there is nothing to explain: the sentence exists for a
    // repository the run left behind.
    expect(result.workScopeLeftOut ?? []).toEqual([]);
  });
});

/**
 * Round 4, M4. A person taking a repository back writes the way people write:
 * "use github:acme/ops", and later "actually not ops".
 *
 * The comment that says no is not read at all, so without this the earlier
 * comment still decides and the repository the person just refused is attached,
 * with the record saying the ticket chose it. A bare name counts for the
 * refusal and never for the choice: "the ops team" in a comment that says yes
 * is not somebody naming a repository.
 */
describe("a comment that takes a repository back", () => {
  const BOT_HERE = "bot-account";
  const NO_ANSWER: PreSandboxStepContext["workScope"] = {
    subjectKey: SUBJECT,
    scope: scope([]),
    selectionAnswered: false,
    answeredRepositoryKeys: [],
  };
  const human = (body: string, createdAt: string) => ({
    author: "Ada",
    accountId: "human-1",
    body,
    createdAt,
  });
  const ticketWith = (...comments: Array<ReturnType<typeof human>>) => ({
    identifier: "AWT-402",
    title: "Invoices are wrong",
    description: "Fix the billing callback in acme/web.",
    acceptanceCriteria: "",
    comments,
    labels: [] as string[],
  });

  it("does not take a repository an earlier comment named and a later one took back by name", async () => {
    const result = await runStep({
      ticket: ticketWith(
        human("Also use github:acme/ops for this.", "2026-09-16T10:00:00.000Z"),
        human("actually not ops", "2026-09-16T11:00:00.000Z"),
      ),
      botAccountId: BOT_HERE,
      workScope: NO_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
    ]);
  });

  it("still takes it when the later comment names it without saying no", async () => {
    const result = await runStep({
      ticket: ticketWith(
        human("Also use github:acme/ops for this.", "2026-09-16T10:00:00.000Z"),
        human("ops is ready now", "2026-09-16T11:00:00.000Z"),
      ),
      botAccountId: BOT_HERE,
      workScope: NO_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/web",
      "acme/ops",
    ]);
  });

  // The ticket's own words are not a comment and are not taken back by one:
  // they are what every question about this work was asked about (C11f).
  it("keeps a repository the description names when a comment says no about it", async () => {
    const result = await runStep({
      ticket: {
        ...ticketWith(human("actually not ops", "2026-09-16T11:00:00.000Z")),
        description: "Fix the billing callback in acme/web and github:acme/ops.",
      },
      botAccountId: BOT_HERE,
      workScope: NO_ANSWER,
    });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toContain(
      "acme/ops",
    );
  });
});

/**
 * Round 5, S1. A person's own comment must never turn the report off.
 *
 * The ticket names five repositories, she answered with one, and every run
 * since has told her, per repository, that the other four were listed in a
 * question she answered and are not selected. Then she writes the two she
 * wants in a comment, which is what our own sentence asks for. That comment
 * unbinds them from the answer, so the run no longer says they were left out
 * of it; the ticket still names more repositories than a run chooses between,
 * so it takes nothing from the text either, and the question is not asked again
 * on a subject that carries an answer. What she did made the only channel that
 * was talking to her go quiet.
 */
describe("a comment written after the answer, on a ticket naming too many", () => {
  const BOT_HERE = "bot-account";
  const FIVE = "Touches acme/web, acme/api, acme/docs, acme/infra and acme/ops in one go.";
  const ANSWERED_AT = "2026-09-16T09:00:00.000Z";
  const FIVE_KEYS = ["web", "api", "docs", "infra", "ops"].map((name) => `github:acme/${name}`);
  const ANSWERED: PreSandboxStepContext["workScope"] = {
    subjectKey: SUBJECT,
    scope: scope([entry({ repositoryKey: "github:acme/web" })]),
    selectionAnswered: true,
    answeredRepositoryKeys: FIVE_KEYS,
    answeredAtByKey: Object.fromEntries(FIVE_KEYS.map((key) => [key, ANSWERED_AT])),
  };
  const ticketWith = (...bodies: string[]) => ({
    identifier: "AWT-402",
    title: "Rename the client",
    description: FIVE,
    acceptanceCriteria: "",
    comments: bodies.map((body) => ({
      author: "Ada",
      accountId: "human-1",
      body,
      createdAt: "2026-09-16T10:00:00.000Z",
    })),
    labels: [] as string[],
  });

  it("keeps reporting a repository she asked for in a comment, and says the comment was read", async () => {
    const said = await runStep({
      ticket: ticketWith("please also github:acme/docs and github:acme/infra"),
      botAccountId: BOT_HERE,
      workScope: ANSWERED,
    });

    // Nothing new is taken: the ticket still names more open repositories than
    // one run chooses between, which is the fact the sentence has to carry.
    expect(said.selectedRepositories?.map((selected) => selected.repoPath)).toEqual(["acme/web"]);
    const left = Object.fromEntries(
      (said.workScopeLeftOut ?? []).map((entry) => [entry.repositoryKey, entry.reason]),
    );
    expect(Object.keys(left).sort()).toEqual([
      "github:acme/api",
      "github:acme/docs",
      "github:acme/infra",
      "github:acme/ops",
    ]);
    expect(left["github:acme/docs"]).toContain("named in a ticket comment written after the answer");
    expect(left["github:acme/docs"]).toContain("did not take it");
    // And the way back is the one that works, said plainly: writing another
    // comment is not it (S2).
    const recovery = (said.workScopeRecoveryNotes ?? []).join(" ");
    expect(recovery).toContain("does not bring github:acme/docs into this work");
    expect(recovery).toContain("work_scope.edit");
    expect(JSON.stringify(said.promptAdditions ?? [])).not.toContain("work_scope.edit");
  });

  // The control, and the state she was in before she wrote anything: all four
  // are reported as left out of the answer.
  it("reports all four when nobody has written since the answer", async () => {
    const said = await runStep({
      ticket: ticketWith(),
      botAccountId: BOT_HERE,
      workScope: ANSWERED,
    });

    expect((said.workScopeLeftOut ?? []).map((entry) => entry.repositoryKey).sort()).toEqual([
      "github:acme/api",
      "github:acme/docs",
      "github:acme/infra",
      "github:acme/ops",
    ]);
  });
});

/**
 * Round 5, S4 and A5. The run that keeps no record still has to act on an
 * answer, or say it did not.
 *
 * A schedule occurrence and a webhook delivery with no subject keep no record
 * by design (`carriesWorkScope`), and a ticket run resuming a context frozen
 * before the record existed has none either. Those runs still ask which
 * repository to work on, and the answer still comes back. Nothing about them
 * has a record to write to, and nothing about them posts the sentence that
 * explains an answer nobody could use, so whatever this path drops is dropped
 * in silence.
 */
describe("an answer to a run that keeps no record", () => {
  const ticket = {
    identifier: "AWT-402",
    title: "Rename the client",
    description: "",
    acceptanceCriteria: "",
    comments: [] as Array<{ author: string; accountId?: string; body: string; createdAt?: string }>,
    labels: [] as string[],
  };
  const replied = (answer: string): PreSandboxStepContext["clarification"] => ({
    answer,
    resolves: "repository_selection",
  });

  it("takes both repositories a reply names", async () => {
    const result = await runStep({ ticket, clarification: replied("acme/api and acme/web") });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath).sort()).toEqual([
      "acme/api",
      "acme/web",
    ]);
  });

  it("asks rather than taking anything from a reply that says no", async () => {
    const result = await runStep({ ticket, clarification: replied("not acme/api") });

    expect(result.selectedRepositories ?? []).toEqual([]);
    expect(result.repositoryDiscovery).toBeDefined();
  });

  it("still takes the one repository a plain reply names", async () => {
    const result = await runStep({ ticket, clarification: replied("acme/api") });

    expect(result.selectedRepositories?.map((selected) => selected.repoPath)).toEqual([
      "acme/api",
    ]);
  });
});
