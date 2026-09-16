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
  readConnectedWorkScope: mocks.readWorkScope,
  readConnectedWorkScopeSelectionAnswered: mocks.readSelectionAnswered,
}));

vi.mock("../../infra/logger.js", () => ({ logger: mocks.logger }));

import { repoSelectionStep } from "./repo-selection.js";
import { testSettingsSnapshot } from "../../test-support/settings.js";
import type { PreSandboxStepContext, PreSandboxStepResult } from "../../engine/pre-sandbox/types.js";

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
  } = {},
): Promise<PreSandboxStepResult> {
  mocks.listRepositories.mockResolvedValueOnce(overrides.repositories ?? ALL);
  return repoSelectionStep({
    context: {
      repositoryAccess: {
        activated: overrides.activated ?? true,
        enabledKeys: overrides.enabledKeys ?? ALL.map((r) => `github:${r.repoPath}`),
      },
      settings: testSettingsSnapshot(),
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
      },
    });

    expect(result.workScopeAsk).toBeUndefined();
    expect(result.status).toBe("continue");
    expect(result.selectedRepositories ?? []).not.toContainEqual(
      expect.objectContaining({ repoPath: "acme/api" }),
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
      workScope: { subjectKey: SUBJECT, scope: null, selectionAnswered: true },
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
      workScope: { subjectKey: SUBJECT, scope: null, selectionAnswered: false },
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
    // it.
    expect(
      (result.promptAdditions ?? []).find(
        (addition) => addition.title === "Repositories left out",
      )?.content,
    ).toContain("could take none of them");
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
    comments: [{ author: "Human clarification", body: "use acme/nope please" }],
    labels: [],
  };
  const NOT_AVAILABLE = "named in the previous answer are not available to this workflow";

  it("reads nothing out of the answer while a record is live", async () => {
    const result = await runStep({
      ticket: ANSWER,
      workScope: { subjectKey: SUBJECT, scope: scope([]), selectionAnswered: false },
    });

    expect(result.status === "halt" ? (result.questions ?? []).join(" ") : "").not.toContain(
      NOT_AVAILABLE,
    );
  });

  // The control, and the reason the case above is worth anything: the same
  // sentence with no record behind it still decides. The gate is the record,
  // not the parser having gone blind.
  it("still reads the answer when there is no record", async () => {
    const result = await runStep({ ticket: ANSWER });

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
      },
    });

    expect(result.status).toBe("halt");
    if (result.status !== "halt") throw new Error("expected a halt");
    expect(result.outcome).toBe("needs_clarification");
    expect(result.questions?.[0]).toContain(
      "github:acme/legacy is recorded on this work, but the repository catalog did not offer it to this run",
    );
    expect(result.questions?.[0]).toContain("acme/web");
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

  it("asks through the record, so the question names the repositories it is about", async () => {
    const result = await runStep({
      repositories: SIX,
      enabledKeys: SIX_KEYS,
      workScope: { subjectKey: SUBJECT, scope: recordOfSix(), selectionAnswered: false },
    });

    expect(result.status).toBe("halt");
    if (result.status !== "halt") throw new Error("expected a halt");
    expect(result.questions?.[0]).toContain(
      "Reply with one or more of: github:acme/api, github:acme/docs, github:acme/infra, " +
        "github:acme/ops, github:acme/tools, github:acme/web.",
    );
    // The question carries what it is about, so the answer has somewhere to land.
    expect(result.workScopeAsk?.askedRepositories.map((asked) => asked.repositoryKey)).toEqual([
      "github:acme/api",
      "github:acme/docs",
      "github:acme/infra",
      "github:acme/ops",
      "github:acme/tools",
      "github:acme/web",
    ]);
  });

  // The whole defence against a second loop: a question nobody may be asked
  // twice must never stop a run, because its answer would change nothing and the
  // next run would count the same repositories and ask again.
  it("does not stop the run when the question is already settled, and says what it took", async () => {
    const result = await runStep({
      repositories: SIX,
      enabledKeys: SIX_KEYS,
      workScope: { subjectKey: SUBJECT, scope: recordOfSix(), selectionAnswered: true },
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
