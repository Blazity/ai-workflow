import { describe, expect, it, vi } from "vitest";

// Publication seams composed by scenarios 2, 3, and 6. These reuse the exact mock
// shapes from workspace-publication.test.ts and trusted-workspace-publisher.test.ts
// without duplicating their whole harnesses: only the seams these three scenarios
// actually reach are mocked. env is mocked minimally (the trusted publisher reads
// only JOB_TIMEOUT_MS, and never before the read-only failure below).
const mocks = vi.hoisted(() => ({
  findPr: vi.fn(),
  createPr: vi.fn(),
  recordIntent: vi.fn(),
  recordPr: vi.fn(),
  getBranchSha: vi.fn(),
  getPrHead: vi.fn(),
  getToken: vi.fn(),
  sourceCommand: vi.fn(),
  readBundle: vi.fn(),
  createSandbox: vi.fn(),
}));

vi.mock("../steps/repository-prs.js", () => ({
  findWorkflowOwnedPullRequestForBranch: mocks.findPr,
  createOrFindWorkflowOwnedPullRequest: mocks.createPr,
  recordWorkflowOwnedPullRequestIntent: mocks.recordIntent,
  recordWorkflowOwnedPullRequest: mocks.recordPr,
}));
vi.mock("../../engine/support/vcs-runtime.js", () => ({
  createRepositoryVcsRuntime: () => ({
    config: {
      kind: "github",
      host: "https://github.com",
      auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
    },
    getToken: mocks.getToken,
    vcs: { getBranchSha: mocks.getBranchSha, getPRHead: mocks.getPrHead },
  }),
}));
vi.mock("../../sandbox/credentials.js", () => ({
  getSandboxCredentials: () => ({ teamId: "team" }),
}));
vi.mock("../../infra/vcs-config.js", () => ({ env: { JOB_TIMEOUT_MS: 120_000 } }));

/** These cases are about multi-repository publication, not about the catalog:
 *  the bridge, where every repository the installation exposes is reachable. */
const UNRESTRICTED = { activated: false, enabledKeys: [] as string[] };
vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(async () => ({
      sandboxId: "source-sandbox",
      runCommand: mocks.sourceCommand,
      readFileToBuffer: mocks.readBundle,
    })),
    create: mocks.createSandbox,
  },
}));

import {
  validateRepositoryDiscoveryResult,
} from "../../engine/repository-discovery/protocol.js";
import {
  EXPANSION_LIMIT_CLARIFICATION_PREFIX,
  decideRepositoryExpansion,
  validateHumanRepositoryExpansion,
  validateRepositoryExpansionRequests,
} from "../../engine/repository-discovery/runner.js";
import type { RepositoryCatalogEntry } from "../../engine/repository-discovery/catalog.js";
// The real comment builder, so a test feeds the question in the form a person
// was actually sent rather than the form we stored.
import { formatClarificationQuestionsComment } from "../support/clarification-comment-format.js";
import { filterPinnedRepositories } from "../../adapters/vcs/repository-directory.js";
import type { WorkspaceManifest } from "../../sandbox/repo-workspace.js";
import { workspaceRepositoryAccess } from "../../sandbox/repo-workspace.js";
import { publishTrustedWorkspaceFromSandbox } from "../steps/trusted-workspace-publisher.js";
import { applyHumanRepositoryExpansion } from "../steps/phase.js";
import { researchPhaseIdentity } from "../blocks/support/types.js";
import { makeCtx } from "../blocks/support/test-support.js";
import {
  openPullRequestsForPublication,
  type FinalizedBranch,
} from "../steps/workspace-publication.js";

function command(stdout = "", stderr = "", exitCode = 0) {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

const catalog: RepositoryCatalogEntry[] = [
  {
    provider: "github",
    repoPath: "acme/service",
    name: "service",
    defaultBranch: "main",
    description: "User-facing service",
    topics: ["typescript"],
    relationships: [],
    usable: true,
  },
  {
    provider: "gitlab",
    repoPath: "acme/shared/contracts",
    name: "contracts",
    defaultBranch: "main",
    description: "Shared contracts",
    topics: ["schema"],
    relationships: [],
    usable: true,
  },
  {
    provider: "gitlab",
    repoPath: "acme/service",
    name: "service mirror",
    defaultBranch: "trunk",
    description: "Distinct provider-scoped repository",
    topics: [],
    relationships: [],
    usable: true,
  },
];

describe("multi-repository research workflow scenarios", () => {
  it("turns an ambiguous ticket into validated selection and plans inside the code workspace", async () => {
    const decision = validateRepositoryDiscoveryResult(
      {
        status: "selected",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/service",
            rationale: "ticket symptom",
          },
        ],
        confidence: "high",
        questions: null,
        error: null,
      },
      catalog,
      [],
    );
    expect(decision).toMatchObject({
      kind: "selected",
      repositories: [{ provider: "github", repoPath: "acme/service" }],
    });
  });

  it("expands from the symptom repository to the shared owner while preserving write-only scope", async () => {
    const expansion = validateRepositoryExpansionRequests({
      requests: [
        {
          provider: "gitlab",
          repoPath: "acme/shared/contracts",
          rationale: "service imports this schema",
        },
      ],
      catalog,
      attached: [{ provider: "github", repoPath: "acme/service" }],
      completedRounds: 0,
    });
    expect(expansion).toMatchObject({
      kind: "attach",
      repositories: [
        { provider: "gitlab", repoPath: "acme/shared/contracts" },
      ],
    });

    const manifest = {
      version: 2 as const,
      repositories: [
        {
          provider: "github" as const,
          repoPath: "acme/service",
          slug: "github__acme__service",
          localPath: "/vercel/sandbox/repos/github__acme__service",
          defaultBranch: "main",
          branchName: "main",
          selectedRationale: "symptom",
          access: "read" as const,
          researchBaseSha: "service-sha",
        },
        {
          provider: "gitlab" as const,
          repoPath: "acme/shared/contracts",
          slug: "gitlab__acme__shared__contracts",
          localPath: "/vercel/sandbox/repos/gitlab__acme__shared__contracts",
          defaultBranch: "main",
          branchName: "blazebot/aiw-147",
          selectedRationale: "owner",
          access: "write" as const,
          researchBaseSha: "contracts-sha",
          expectedRemoteSha: "contracts-sha",
          preAgentSha: "contracts-sha",
        },
      ],
    };
    expect(
      manifest.repositories.map((repository) =>
        workspaceRepositoryAccess(manifest, repository),
      ),
    ).toEqual(["read", "write"]);

    // Only the write-scoped shared owner X changed; the read-only symptom repo Y
    // never becomes a finalized branch, so exactly one PR is opened, for X.
    const finalizedX: FinalizedBranch = {
      provider: "gitlab",
      repoPath: "acme/shared/contracts",
      branchName: "blazebot/aiw-147",
      defaultBranch: "main",
      expectedHead: "contracts-sha",
      pushedHead: "after-contracts",
    };
    mocks.findPr.mockReset().mockResolvedValue(null);
    mocks.recordIntent.mockReset().mockResolvedValue(undefined);
    mocks.recordPr.mockReset().mockResolvedValue(undefined);
    mocks.getBranchSha.mockReset().mockResolvedValue(finalizedX.pushedHead);
    mocks.getPrHead
      .mockReset()
      .mockResolvedValue({ headSha: finalizedX.pushedHead, baseRef: "main", state: "open" });
    mocks.createPr.mockReset().mockResolvedValue({
      provider: "gitlab",
      repoPath: "acme/shared/contracts",
      id: 21,
      url: "https://gitlab.com/acme/shared/contracts/-/merge_requests/21",
      branch: finalizedX.branchName,
      isNew: true,
    });

    const publication = await openPullRequestsForPublication({
      runId: "run-1",
      subjectKey: "ticket:jira:AIW-147",
      ownerToken: "owner-1",
      ticketKey: "AIW-147",
      repositoryAccess: UNRESTRICTED,
      repositories: [finalizedX],
      title: "AIW-147",
      body: "Change the shared owner only",
    });

    expect(publication).toMatchObject({
      status: "published",
      prs: [{ id: 21, repoPath: "acme/shared/contracts" }],
    });
    expect(mocks.createPr).toHaveBeenCalledTimes(1);
  });

  // A definition pin attaches its repositories from the start but must not close
  // the shared-owner expansion: the expansion catalog is narrowed by PROVIDER
  // only, never to the pinned repository list, and every round limit still holds.
  it("still expands to a non-pinned repository under a definition pin", () => {
    const pinnedScope = {
      providers: ["github" as const, "gitlab" as const],
      repositories: [{ provider: "github" as const, repoPath: "acme/service" }],
    };
    const expansionCatalog = filterPinnedRepositories(catalog, {
      providers: pinnedScope.providers,
    });
    expect(expansionCatalog).toHaveLength(catalog.length);

    expect(
      validateRepositoryExpansionRequests({
        requests: [
          {
            provider: "gitlab",
            repoPath: "acme/shared/contracts",
            rationale: "service imports this schema",
          },
        ],
        catalog: expansionCatalog,
        attached: [{ provider: "github", repoPath: "acme/service" }],
        completedRounds: 1,
      }),
    ).toMatchObject({
      kind: "attach",
      repositories: [{ provider: "gitlab", repoPath: "acme/shared/contracts" }],
    });

    // The pin changes neither the round limit nor the catalog membership rule.
    expect(
      validateRepositoryExpansionRequests({
        requests: [
          {
            provider: "gitlab",
            repoPath: "acme/shared/contracts",
            rationale: "late request",
          },
        ],
        catalog: expansionCatalog,
        attached: [{ provider: "github", repoPath: "acme/service" }],
        completedRounds: 2,
      }),
    ).toMatchObject({ kind: "clarification_needed" });
  });

  it("narrows the expansion catalog to the pinned providers", () => {
    const gitlabOnly = filterPinnedRepositories(catalog, { providers: ["gitlab"] });
    expect(gitlabOnly.map((entry) => entry.provider)).toEqual(["gitlab", "gitlab"]);

    expect(
      validateRepositoryExpansionRequests({
        requests: [
          {
            provider: "github",
            repoPath: "acme/service",
            rationale: "excluded provider",
          },
        ],
        catalog: gitlabOnly,
        attached: [{ provider: "gitlab", repoPath: "acme/service" }],
        completedRounds: 0,
      }),
    ).toMatchObject({
      kind: "clarification_needed",
      questions: [
        expect.stringContaining("github:acme/service, which is not available to this run"),
      ],
    });
  });

  it("turns a third expansion round into targeted clarification", () => {
    expect(
      validateRepositoryExpansionRequests({
        requests: [
          {
            provider: "gitlab",
            repoPath: "acme/shared/contracts",
            rationale: "late request",
          },
        ],
        catalog,
        attached: [{ provider: "github", repoPath: "acme/service" }],
        completedRounds: 2,
      }),
    ).toMatchObject({
      kind: "clarification_needed",
      questions: [expect.stringContaining("maximum of 2")],
    });
  });

  it("keeps a PR-trigger repository mandatory even when discovery selects another repository", () => {
    const mandatory = {
      provider: "github" as const,
      repoPath: "acme/service",
      defaultBranch: "main",
      selectedRationale: "source pull request",
    };
    const decision = validateRepositoryDiscoveryResult(
      {
        status: "selected",
        repositories: [
          {
            provider: "gitlab",
            repoPath: "acme/shared/contracts",
            rationale: "import owner",
          },
        ],
        confidence: "high",
        questions: null,
        error: null,
      },
      catalog,
      [mandatory],
    );

    expect(decision).toMatchObject({
      kind: "selected",
      repositories: [
        { provider: "github", repoPath: "acme/service" },
        { provider: "gitlab", repoPath: "acme/shared/contracts" },
      ],
    });
  });

  it("treats identical paths on GitHub and GitLab as distinct identities", () => {
    const decision = validateRepositoryDiscoveryResult(
      {
        status: "selected",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/service",
            rationale: "primary",
          },
          {
            provider: "gitlab",
            repoPath: "acme/service",
            rationale: "mirror-specific config",
          },
        ],
        confidence: "high",
        questions: null,
        error: null,
      },
      catalog,
      [],
    );

    expect(decision.kind).toBe("selected");
    if (decision.kind === "selected") {
      expect(
        decision.repositories.map(
          (repository) => `${repository.provider}:${repository.repoPath}`,
        ),
      ).toEqual(["github:acme/service", "gitlab:acme/service"]);
    }
  });
});

describe("human repository expansion beyond the model round limit", () => {
  const v2Manifest = { version: 2 as const, repositories: [] };
  const attachedManifest = { version: 2 as const, repositories: [] };

  function ctxWithLimitAnswer(answer: string) {
    return makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: v2Manifest,
      selectedRepositories: [
        {
          provider: "github",
          repoPath: "acme/service",
          defaultBranch: "main",
          selectedRationale: "symptom",
        },
      ],
      // Asked by this run, which is `makeCtx`'s `run-1`: a repository answer is
      // re-applied only by the run that asked for it, so a round from any other
      // run is one this run leaves alone (A42).
      clarifications: [
        {
          questions: [`${EXPANSION_LIMIT_CLARIFICATION_PREFIX} Reply with repo paths.`],
          answer,
          runId: "run-1",
        },
      ],
    });
  }

  it("attaches a human-named catalog repository and continues research", async () => {
    const ctx = ctxWithLimitAnswer("gitlab:acme/shared/contracts");
    const attach = vi.fn(async () => ({
      manifest: attachedManifest,
      cloneDurationMs: 5,
    }));
    const fetchContexts = vi.fn(async () => []);

    const result = await applyHumanRepositoryExpansion(ctx, {
      resolve: async (answer, attached) =>
        validateHumanRepositoryExpansion({ answer, catalog, attached }),
      attach,
      fetchContexts,
    });

    expect(result.kind).toBe("attached");
    expect(attach).toHaveBeenCalledWith([
      {
        provider: "gitlab",
        repoPath: "acme/shared/contracts",
        defaultBranch: "main",
        selectedRationale: "requested by human clarification answer",
      },
    ]);
    expect(ctx.selectedRepositories).toHaveLength(2);
    expect(ctx.workspaceManifest).toBe(attachedManifest);
    // The attach is recorded on the run state: the streak that closes expansion
    // starts over, and the clarification round it consumed is marked.
    expect(ctx.repositoryExpansion.allAttachedRequests).toBe(0);
    expect(ctx.repositoryExpansion.humanAttachRound).toBe(1);
    expect(ctx.repositoryExpansion.expansionClosed).toBeUndefined();
  });

  it("returns a clarification without attaching when the human names an off-catalog repository", async () => {
    const ctx = ctxWithLimitAnswer("github:acme/not-installed");
    const attach = vi.fn();

    const result = await applyHumanRepositoryExpansion(ctx, {
      resolve: async (answer, attached) =>
        validateHumanRepositoryExpansion({ answer, catalog, attached }),
      attach,
      fetchContexts: async () => [],
    });

    expect(result.kind).toBe("clarification");
    expect(attach).not.toHaveBeenCalled();
  });

  it.each(["", "none", "no more repositories", "github:acme/service"])(
    "reads %o as no further repositories and resumes without a second question",
    async (answer) => {
      // AIW-377: an answer naming nothing new is an explicit "no further
      // repositories". The run must resume into planning with what is attached,
      // and the expansion question must never be raised again.
      const ctx = ctxWithLimitAnswer(answer);
      const attach = vi.fn();

      const result = await applyHumanRepositoryExpansion(ctx, {
        resolve: async (answerText, attached) =>
          validateHumanRepositoryExpansion({ answer: answerText, catalog, attached }),
        attach,
        fetchContexts: async () => [],
      });

      expect(result).toEqual({ kind: "noop" });
      expect(attach).not.toHaveBeenCalled();
      expect(ctx.selectedRepositories).toHaveLength(1);
      // Recorded on the run, which is what keeps the question from coming back.
      expect(ctx.repositoryExpansion.expansionClosed).toBe("human");
    },
  );

  it("asks once about an unreadable answer, then stops asking", async () => {
    // Prose is not a refusal: the human meant something, so they get one
    // targeted re-ask and the run keeps its ability to expand. The second
    // unreadable answer is where it ends: a third question is the loop this
    // whole fix exists to stop (AIW-377). Driven end to end through the resume
    // path, because the re-ask is only actionable if the question it raises is
    // one the resume path recognizes.
    const ctx = ctxWithLimitAnswer("use the shared one");
    const deps = {
      resolve: async (
        answer: string,
        attached: Array<{ provider: "github" | "gitlab"; repoPath: string }>,
      ) => validateHumanRepositoryExpansion({ answer, catalog, attached }),
      attach: vi.fn(),
      fetchContexts: async () => [],
    };

    const first = await applyHumanRepositoryExpansion(ctx, deps);
    expect(first.kind).toBe("clarification");
    expect(ctx.repositoryExpansion.expansionClosed).toBeUndefined();
    expect(ctx.repositoryExpansion.unrecognisedAnswers).toBe(1);

    // The run parks on that question and the human answers it, still without a
    // path. The question carries the expansion prefix, so this answer is read
    // at all instead of being dropped.
    if (first.kind !== "clarification") throw new Error("expected a clarification");
    ctx.clarifications = [
      ...(ctx.clarifications ?? []),
      { questions: first.questions, answer: "whatever you think is best", runId: "run-1" },
    ];

    const second = await applyHumanRepositoryExpansion(ctx, deps);
    expect(second).toEqual({ kind: "noop" });
    expect(ctx.repositoryExpansion.expansionClosed).toBe("human");

    // And no third question: nothing is asked once expansion is closed.
    ctx.clarifications = [
      ...(ctx.clarifications ?? []),
      { questions: first.questions, answer: "still nothing", runId: "run-1" },
    ];
    const third = await applyHumanRepositoryExpansion(ctx, deps);
    expect(third).toEqual({ kind: "noop" });
    expect(deps.attach).not.toHaveBeenCalled();
  });

  it("asks once about an unavailable repository, even after the answer attached another", async () => {
    // Driven the way the planning block drives it: at the top of every loop
    // pass the resume path reads the latest answer, then research asks for
    // repositories and the closure applies the decision and stores its state.
    // github:acme/private is not on the catalog this run was frozen with, so
    // the person can add another repository but cannot give the run that one.
    const ctx = makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: v2Manifest,
      selectedRepositories: [
        {
          provider: "github",
          repoPath: "acme/service",
          defaultBranch: "main",
          selectedRationale: "symptom",
        },
      ],
    });
    const deps = {
      resolve: async (
        answer: string,
        attached: Array<{ provider: "github" | "gitlab"; repoPath: string }>,
      ) => validateHumanRepositoryExpansion({ answer, catalog, attached }),
      attach: vi.fn(async () => ({ manifest: attachedManifest, cloneDurationMs: 5 })),
      fetchContexts: async () => [],
    };
    const privateRequest = {
      provider: "github" as const,
      repoPath: "acme/private",
      rationale: "the ticket names it",
    };
    const raised: string[][] = [];
    // What the closure does with one research pass that asked for the private
    // repository: every action it can take, and the state it keeps.
    const researchAsksForPrivate = () => {
      const { action, state } = decideRepositoryExpansion({
        origin: "model",
        verdict: validateRepositoryExpansionRequests({
          requests: [privateRequest],
          catalog,
          attached: ctx.selectedRepositories,
          completedRounds: ctx.repositoryExpansion.rounds,
          allAttachedRequests: ctx.repositoryExpansion.allAttachedRequests ?? 0,
          askedUnavailable: ctx.repositoryExpansion.askedUnavailable,
        }),
        state: ctx.repositoryExpansion,
        requests: [privateRequest],
      });
      ctx.repositoryExpansion = state;
      if (action.kind === "ask_limit" || action.kind === "ask_unrecognised") {
        raised.push(action.questions);
      }
      return action;
    };

    // Pass one: nothing answered yet, research asks, the person is asked once.
    expect(await applyHumanRepositoryExpansion(ctx, deps)).toEqual({ kind: "noop" });
    const first = researchAsksForPrivate();
    expect(first.kind).toBe("ask_unrecognised");
    expect(raised).toHaveLength(1);

    // The person answers with a link to another repository, which is attached.
    ctx.clarifications = [
      { questions: raised[0], answer: "https://gitlab.com/acme/shared/contracts", runId: "run-1" },
    ];
    const attached = await applyHumanRepositoryExpansion(ctx, deps);
    expect(attached.kind).toBe("attached");
    expect(deps.attach).toHaveBeenCalledWith([
      {
        provider: "gitlab",
        repoPath: "acme/shared/contracts",
        defaultBranch: "main",
        selectedRationale: "requested by human clarification answer",
      },
    ]);

    // Pass two: research asks for the private repository again. Nobody is
    // asked; the run carries on as if the person had answered "none".
    expect(await applyHumanRepositoryExpansion(ctx, deps)).toEqual({ kind: "noop" });
    expect(researchAsksForPrivate()).toEqual({ kind: "proceed" });
    expect(ctx.repositoryExpansion.expansionClosed).toBe("human");

    // Pass three, closed: still asking for it buys nothing. The run does not
    // ask a second time and does not die either: the corrective pass it spent
    // on pass two was the last one this request could buy, so the loop stops
    // restarting and the run plans with what it holds.
    expect(await applyHumanRepositoryExpansion(ctx, deps)).toEqual({ kind: "noop" });
    expect(researchAsksForPrivate()).toEqual({ kind: "plan_without" });
    expect(raised).toHaveLength(1);
    expect(deps.attach).toHaveBeenCalledTimes(1);
  });

  it("does not read a consumed answer as a refusal on the next loop pass", async () => {
    // The answer that attached a repository stays the LATEST clarification, so
    // the next pass of the planning loop re-reads it with everything it named
    // already attached and reports "exhausted". Closing expansion on that would
    // close it behind the human's back, right after they asked for more.
    const ctx = ctxWithLimitAnswer("gitlab:acme/shared/contracts");
    const deps = {
      resolve: async (answer: string, attached: Array<{ provider: "github" | "gitlab"; repoPath: string }>) =>
        validateHumanRepositoryExpansion({ answer, catalog, attached }),
      attach: async () => ({ manifest: attachedManifest, cloneDurationMs: 5 }),
      fetchContexts: async () => [],
    };

    const first = await applyHumanRepositoryExpansion(ctx, deps);
    expect(first.kind).toBe("attached");

    const second = await applyHumanRepositoryExpansion(ctx, deps);
    expect(second).toEqual({ kind: "noop" });
    expect(ctx.repositoryExpansion.expansionClosed).toBeUndefined();
  });

  it.each([
    {
      name: "an off-catalog repository",
      answer: "github:acme/not-installed",
      attachedCount: 1,
      isAllowed: undefined as ((repoPath: string) => boolean) | undefined,
      followUp: "gitlab:acme/shared/contracts",
      consumed: "attached" as const,
    },
    {
      name: "a bare path that exists on two providers",
      answer: "acme/service",
      attachedCount: 1,
      isAllowed: undefined as ((repoPath: string) => boolean) | undefined,
      followUp: "gitlab:acme/shared/contracts",
      consumed: "attached" as const,
    },
    {
      name: "a repository the allowlist refuses",
      answer: "gitlab:acme/shared/contracts",
      attachedCount: 1,
      isAllowed: (() => false) as ((repoPath: string) => boolean) | undefined,
      followUp: "none",
      consumed: "closed" as const,
    },
    {
      name: "an attach that would cross the workspace ceiling",
      answer: "gitlab:acme/shared/contracts",
      attachedCount: 8,
      isAllowed: undefined as ((repoPath: string) => boolean) | undefined,
      followUp: "none",
      consumed: "closed" as const,
    },
    {
      name: "an answer no repository path could be read from",
      answer: "use the shared one",
      attachedCount: 1,
      isAllowed: undefined as ((repoPath: string) => boolean) | undefined,
      followUp: "gitlab:acme/shared/contracts",
      consumed: "attached" as const,
    },
  ])(
    "reads the reply to the question it raised about $name",
    async ({ answer, attachedCount, isAllowed, followUp, consumed }) => {
      // Every question this path raises has to be one the resume path
      // recognizes. A question without the expansion prefix is a question whose
      // answer is dropped: the run would research on with what it had and the
      // person would never learn their reply went nowhere (AIW-377).
      const ctx = makeCtx({
        sandboxId: "sbx-research",
        workspaceManifest: v2Manifest,
        selectedRepositories: Array.from({ length: attachedCount }, (_, index) => ({
          provider: "github" as const,
          repoPath: index === 0 ? "acme/service" : `acme/filler-${index}`,
          defaultBranch: "main",
          selectedRationale: "symptom",
        })),
        clarifications: [
          {
            questions: [`${EXPANSION_LIMIT_CLARIFICATION_PREFIX} Reply with repo paths.`],
            answer,
            runId: "run-1",
          },
        ],
      });
      const deps = {
        resolve: async (
          answerText: string,
          attached: Array<{ provider: "github" | "gitlab"; repoPath: string }>,
        ) =>
          validateHumanRepositoryExpansion({
            answer: answerText,
            catalog,
            attached,
            isAllowed,
          }),
        attach: vi.fn(async () => ({
          manifest: attachedManifest,
          cloneDurationMs: 5,
        })),
        fetchContexts: async () => [],
      };

      const first = await applyHumanRepositoryExpansion(ctx, deps);
      expect(first.kind).toBe("clarification");
      if (first.kind !== "clarification") throw new Error("expected a clarification");

      // The run parks on that question and the person answers it.
      ctx.clarifications = [
        ...(ctx.clarifications ?? []),
        { questions: first.questions, answer: followUp, runId: "run-1" },
      ];
      const second = await applyHumanRepositoryExpansion(ctx, deps);

      if (consumed === "attached") {
        expect(second.kind).toBe("attached");
        expect(deps.attach).toHaveBeenCalledTimes(1);
      } else {
        // Consumed the other way: the reply said there is nothing more, which
        // closes expansion instead of asking again.
        expect(second).toEqual({ kind: "noop" });
        expect(ctx.repositoryExpansion.expansionClosed).toBe("human");
        expect(deps.attach).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      name: "attaches the repository the human names instead",
      followUp: "gitlab:acme/shared/contracts",
      consumed: "attached" as const,
    },
    {
      name: "closes expansion when the human names no repository",
      followUp: "none",
      consumed: "closed" as const,
    },
  ])(
    "reads the reply to a question the model path raised and $name",
    async ({ followUp, consumed }) => {
      // The model asked for a repository that is not on the catalog, so the run
      // parked on the validator's own question, not the expansion-limit one.
      // That question has to be recognized on resume as well: otherwise the
      // human answer is dropped and research restarts ignoring it (AIW-377).
      const parked = validateRepositoryExpansionRequests({
        requests: [
          { provider: "github", repoPath: "acme/not-installed", rationale: "guess" },
        ],
        catalog,
        attached: [{ provider: "github", repoPath: "acme/service" }],
        completedRounds: 0,
      });
      expect(parked.kind).toBe("clarification_needed");
      if (parked.kind !== "clarification_needed") throw new Error("expected a clarification");

      const ctx = makeCtx({
        sandboxId: "sbx-research",
        workspaceManifest: v2Manifest,
        selectedRepositories: [
          {
            provider: "github" as const,
            repoPath: "acme/service",
            defaultBranch: "main",
            selectedRationale: "symptom",
          },
        ],
        clarifications: [{ questions: parked.questions, answer: followUp, runId: "run-1" }],
      });
      const attach = vi.fn(async () => ({
        manifest: attachedManifest,
        cloneDurationMs: 5,
      }));
      const result = await applyHumanRepositoryExpansion(ctx, {
        resolve: async (
          answerText: string,
          attached: Array<{ provider: "github" | "gitlab"; repoPath: string }>,
        ) => validateHumanRepositoryExpansion({ answer: answerText, catalog, attached }),
        attach,
        fetchContexts: async () => [],
      });

      if (consumed === "attached") {
        expect(result.kind).toBe("attached");
        expect(attach).toHaveBeenCalledTimes(1);
        expect(ctx.selectedRepositories).toHaveLength(2);
      } else {
        expect(result).toEqual({ kind: "noop" });
        expect(ctx.repositoryExpansion.expansionClosed).toBe("human");
        expect(attach).not.toHaveBeenCalled();
      }
    },
  );

  it("no-ops when the latest clarification is not the expansion-limit prompt", async () => {
    const ctx = makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: v2Manifest,
      clarifications: [
        {
          questions: ["Which repository should this ticket modify?"],
          answer: "github:acme/service",
          runId: "run-1",
        },
      ],
    });
    const attach = vi.fn();

    const result = await applyHumanRepositoryExpansion(ctx, {
      resolve: async () => {
        throw new Error("resolve must not run for a non-expansion clarification");
      },
      attach,
      fetchContexts: async () => [],
    });

    expect(result).toEqual({ kind: "noop" });
    expect(attach).not.toHaveBeenCalled();
  });
});

describe("an answer that quotes our question back is read as the person's words only", () => {
  const v2Manifest = { version: 2 as const, repositories: [] };
  const attached = [{ provider: "github" as const, repoPath: "acme/service" }];

  /** The question the expansion path actually raises, taken from the validator
   *  rather than written out here: what this guards is what OUR OWN sentence
   *  does to the parser, which a fixture could not prove. */
  const REAL_QUESTION = (() => {
    const asked = validateHumanRepositoryExpansion({
      answer: "use the shared one",
      catalog,
      attached,
    });
    if (asked.kind !== "unrecognised_answer") throw new Error("expected a re-ask");
    return asked.questions[0] as string;
  })();

  /** THE LINE A PERSON ACTUALLY SEES, built by the real comment formatter: the
   *  ticket never shows the stored string, it shows `${i + 1}. ` in front of the
   *  published question. A hand-written fixture here is what let a drop that
   *  fired on no real channel look green. */
  const POSTED_QUESTION = (() => {
    const comment = formatClarificationQuestionsComment({
      questions: [REAL_QUESTION],
      suggestedAnswers: null,
      dashboardUrl: "https://dashboard.example/tickets/AWT-1",
      aiColumnName: "Ai",
      expiresAtIso: null,
    });
    const numbered = comment.split("\n").find((line) => line.startsWith("1. "));
    if (!numbered) throw new Error("the questions comment no longer numbers its questions");
    return numbered;
  })();

  /** And what the ticket channel composes when it turns comments into one
   *  answer: every comment's first line carries its author. */
  const COMPOSED_QUESTION = `Filip Maszota: ${POSTED_QUESTION}`;

  function ctxAnswering(answer: string) {
    return makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: v2Manifest,
      selectedRepositories: [
        {
          provider: "github",
          repoPath: "acme/service",
          defaultBranch: "main",
          selectedRationale: "symptom",
        },
      ],
      clarifications: [{ questions: [REAL_QUESTION], answer, runId: "run-1" }],
    });
  }

  async function resume(answer: string) {
    const ctx = ctxAnswering(answer);
    const attach = vi.fn(async () => ({ manifest: v2Manifest, cloneDurationMs: 5 }));
    const result = await applyHumanRepositoryExpansion(ctx, {
      resolve: async (answerText, alreadyAttached, askedQuestions) =>
        validateHumanRepositoryExpansion({
          answer: answerText,
          catalog,
          attached: alreadyAttached,
          askedQuestions,
        }),
      attach,
      fetchContexts: async () => [],
    });
    return { ctx, result, attach };
  }

  it.each([
    ["as the ticket posted it", () => POSTED_QUESTION],
    ["as the ticket composed it, with the author in front", () => COMPOSED_QUESTION],
    ["as the dashboard shows it, word for word", () => REAL_QUESTION],
  ])("attaches nothing when the answer is the question quoted back %s", async (_form, quoted) => {
    // Our answer-format sentence names "github:owner/repo" and
    // "gitlab:group/repo" as the shape to reply in, so a quoted question
    // carries parseable paths nobody typed. A person refusing in plain words
    // must not have a repository cloned on the strength of our own example.
    const { ctx, result, attach } = await resume(`${quoted()}\nno, we do not need it`);

    expect(result.kind).toBe("clarification");
    expect(attach).not.toHaveBeenCalled();
    // And our own placeholders were not recorded as repositories this person
    // was asked about: that list is what stops the run asking again, so a
    // phantom in it silences a question somebody should have been asked.
    expect(ctx.repositoryExpansion.askedUnavailable).toBeUndefined();
  });

  it("still reads the repository typed underneath the quoted question", async () => {
    const { result, attach } = await resume(
      `${POSTED_QUESTION}\ngitlab:acme/shared/contracts`,
    );

    expect(result.kind).toBe("attached");
    expect(attach).toHaveBeenCalledWith([
      {
        provider: "gitlab",
        repoPath: "acme/shared/contracts",
        defaultBranch: "main",
        selectedRationale: "requested by human clarification answer",
      },
    ]);
  });

  it("compares against the question as the ticket published it, scrub and all", () => {
    // A question the publication scrub rewrites reaches a person in a form that
    // does not equal what we stored, so the comparison has to carry the
    // published form too, or the drop misses the only line they ever saw.
    const question =
      "Repository expansion: should this work also touch gitlab:acme/shared/contracts?" +
      " Session memory has been updated for this task.";
    const postedLine = formatClarificationQuestionsComment({
      questions: [question],
      suggestedAnswers: null,
      dashboardUrl: "https://dashboard.example/tickets/AWT-1",
      aiColumnName: "Ai",
      expiresAtIso: null,
    })
      .split("\n")
      .find((line) => line.startsWith("1. "));
    expect(postedLine).toBeDefined();
    expect(postedLine).not.toContain("Session memory");

    const verdict = validateHumanRepositoryExpansion({
      answer: `${postedLine}\nno, we do not need it`,
      catalog,
      attached,
      askedQuestions: [question],
    });

    expect(verdict.kind).toBe("unrecognised_answer");
  });

  it("drops the quoted line whatever case and spacing it comes back in", async () => {
    // A mail client rewraps and an editor changes case; the comparison is the
    // record reader's, trimmed and case insensitive, so the two readers of one
    // answer cannot disagree about what the person named.
    const reflowed = `   ${POSTED_QUESTION.toUpperCase().replace(/ /gu, "  ")}   `;
    const { ctx, result } = await resume(`${reflowed}\nyes`);

    expect(result.kind).toBe("clarification");
    expect(ctx.repositoryExpansion.askedUnavailable).toBeUndefined();
  });
});

describe("scenario 3: changes in two repositories produce two PRs", () => {
  const common = {
    runId: "run-1",
    subjectKey: "ticket:jira:AIW-147",
    ownerToken: "owner-1",
    ticketKey: "AIW-147",
    repositoryAccess: UNRESTRICTED,
    jobTimeoutMs: 120_000,
  };
  const repoX: FinalizedBranch = {
    provider: "github",
    repoPath: "acme/service",
    branchName: "blazebot/AIW-147",
    defaultBranch: "main",
    expectedHead: "before-x",
    pushedHead: "after-x",
  };
  const repoY: FinalizedBranch = {
    provider: "gitlab",
    repoPath: "acme/shared/contracts",
    branchName: "blazebot/AIW-147-contracts",
    defaultBranch: "main",
    expectedHead: "before-y",
    pushedHead: "after-y",
  };

  it("opens exactly one review link per changed write repository", async () => {
    mocks.findPr.mockReset().mockResolvedValue(null);
    mocks.recordIntent.mockReset().mockResolvedValue(undefined);
    mocks.recordPr.mockReset().mockResolvedValue(undefined);
    mocks.createPr
      .mockReset()
      .mockResolvedValueOnce({
        provider: "github",
        repoPath: "acme/service",
        id: 12,
        url: "https://github.com/acme/service/pull/12",
        branch: repoX.branchName,
        isNew: true,
      })
      .mockResolvedValueOnce({
        provider: "gitlab",
        repoPath: "acme/shared/contracts",
        id: 13,
        url: "https://gitlab.com/acme/shared/contracts/-/merge_requests/13",
        branch: repoY.branchName,
        isNew: true,
      });
    mocks.getBranchSha
      .mockReset()
      .mockResolvedValueOnce(repoX.pushedHead)
      .mockResolvedValueOnce(repoY.pushedHead);
    mocks.getPrHead
      .mockReset()
      .mockResolvedValueOnce({ headSha: repoX.pushedHead, baseRef: "main", state: "open" })
      .mockResolvedValueOnce({ headSha: repoY.pushedHead, baseRef: "main", state: "open" });

    const result = await openPullRequestsForPublication({
      ...common,
      repositories: [repoX, repoY],
      title: "AIW-147",
      body: "Changes across two repositories",
    });

    expect(result).toMatchObject({
      status: "published",
      repositories: [repoX, repoY],
      prs: [{ id: 12 }, { id: 13 }],
    });
    expect(mocks.createPr).toHaveBeenCalledTimes(2);
  });
});

describe("scenario 6: a read-only repository mutation produces zero pushes", () => {
  const owner = {
    subjectKey: "ticket:jira:AIW-147",
    ownerToken: "owner-1",
    runId: "run-1",
    repositoryAccess: UNRESTRICTED,
    jobTimeoutMs: 120_000,
  };

  function writeRepo() {
    return {
      provider: "github" as const,
      repoPath: "acme/service",
      slug: "acme__service",
      localPath: "/vercel/sandbox",
      defaultBranch: "main",
      branchName: "blazebot/AIW-147",
      selectedRationale: "ticket repository",
      access: "write" as const,
      expectedRemoteSha: "before-acme/service",
      preAgentSha: "before-acme/service",
    };
  }
  function readRepo() {
    return {
      provider: "github" as const,
      repoPath: "acme/shared",
      slug: "acme__shared",
      localPath: "/vercel/sandbox/repos/shared",
      defaultBranch: "main",
      branchName: "main",
      selectedRationale: "read context",
      access: "read" as const,
      researchBaseSha: "before-acme/shared",
    };
  }

  it("fails every publication before any push when a read-only repository changed", async () => {
    mocks.getToken.mockReset().mockResolvedValue("secret");
    mocks.getBranchSha.mockReset().mockResolvedValue("before-acme/service");
    mocks.getPrHead
      .mockReset()
      .mockResolvedValue({ headSha: "trigger", baseRef: "main", state: "open" });
    mocks.createSandbox.mockReset();
    // The read-only clone's HEAD moved off its research baseline; the write repo
    // is otherwise clean and ready to push.
    mocks.sourceCommand.mockReset().mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("rev-parse") && args.includes("/vercel/sandbox/repos/shared")) {
        return command("changed-shared");
      }
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: {
        version: 2,
        repositories: [writeRepo(), readRepo()],
      } satisfies WorkspaceManifest,
      ...owner,
    });

    expect(result.pushed).toBe(false);
    expect(result.repositories[1]).toMatchObject({
      changed: true,
      failureKind: "read_only_changed",
    });
    // No credentialed publisher sandbox is ever created, so no push can happen.
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });
});

describe("expansion state survives a clarification round-trip", () => {
  // The expansion loop in agent-workflow.ts is an inline closure, so these
  // tests drive the two exported seams it is built from: the validator decides
  // the verdict, decideRepositoryExpansion decides the action and the next
  // state, and the closure only performs the action and stores the state.
  // Limitation: this models the durable state that replay reconstructs (by
  // re-running the memoized expansion step) rather than exercising the workflow
  // replay machinery itself.
  function advanceExpansion(
    ctx: ReturnType<typeof makeCtx>,
    requests: Array<{
      provider: "github" | "gitlab";
      repoPath: string;
      rationale: string;
    }>,
    attached: Array<{ provider: "github" | "gitlab"; repoPath: string }>,
  ) {
    const verdict = validateRepositoryExpansionRequests({
      requests,
      catalog,
      attached,
      completedRounds: ctx.repositoryExpansion.rounds,
      allAttachedRequests: ctx.repositoryExpansion.allAttachedRequests,
    });
    const { action, state } = decideRepositoryExpansion({
      origin: "model",
      verdict,
      state: ctx.repositoryExpansion,
      requests,
    });
    ctx.repositoryExpansion = state;
    return { verdict, action };
  }

  it("keeps the round count and the recorded requests across a clarification", () => {
    const ctx = makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: { version: 2, repositories: [] },
      selectedRepositories: [
        {
          provider: "github",
          repoPath: "acme/service",
          defaultBranch: "main",
          selectedRationale: "symptom",
        },
      ],
    });
    expect(ctx.repositoryExpansion).toEqual({ rounds: 0, priorRequests: [] });

    const firstRequests = [
      {
        provider: "gitlab" as const,
        repoPath: "acme/shared/contracts",
        rationale: "imports",
      },
    ];
    expect(
      advanceExpansion(ctx, firstRequests, ctx.selectedRepositories).action.kind,
    ).toBe("attach");
    expect(ctx.repositoryExpansion.rounds).toBe(1);

    // A clarification suspend/resume does not touch ctx.repositoryExpansion.
    ctx.clarifications = [
      { questions: ["Anything else this ticket should modify?"], answer: "no" },
    ];

    // Regression guard: the counter is not reset to 0 by the clarification, and
    // the recorded prior requests survive.
    expect(ctx.repositoryExpansion.rounds).toBe(1);
    expect(ctx.repositoryExpansion.priorRequests).toEqual(firstRequests);

    // The next request is decided with rounds=1 (still below the two-round
    // limit), so a fresh repository attaches instead of tripping it.
    expect(
      advanceExpansion(
        ctx,
        [{ provider: "gitlab", repoPath: "acme/service", rationale: "mirror config" }],
        [
          ...ctx.selectedRepositories,
          { provider: "gitlab", repoPath: "acme/shared/contracts" },
        ],
      ).action.kind,
    ).toBe("attach");
  });

  // AIW-284: research asking only for repositories the workspace already holds
  // used to park the whole run on "Which additional repository is required?",
  // which no human can answer, because everything named was already there.
  // AIW-377: the round limit no longer overtakes that no-op either, so the
  // consecutive all-attached bound is what ends the loop.
  it("keeps researching on an all-attached request once, and only once", () => {
    const ctx = makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: { version: 2, repositories: [] },
      selectedRepositories: [
        {
          provider: "github",
          repoPath: "acme/service",
          defaultBranch: "main",
          selectedRationale: "symptom",
        },
        {
          provider: "gitlab",
          repoPath: "acme/shared/contracts",
          defaultBranch: "main",
          selectedRationale: "imports",
        },
      ],
    });

    const requests = [
      {
        provider: "gitlab" as const,
        repoPath: "acme/shared/contracts",
        rationale: "need the schema",
      },
      {
        provider: "github" as const,
        repoPath: "acme/service",
        rationale: "need the caller",
      },
    ];

    const first = advanceExpansion(ctx, requests, ctx.selectedRepositories);
    // The run keeps going: no clarification, and nothing to clone.
    expect(first.verdict).toEqual({ kind: "already_attached" });
    expect(first.action).toEqual({ kind: "proceed" });
    expect(ctx.repositoryExpansion.rounds).toBe(1);
    expect(ctx.repositoryExpansion.priorRequests).toEqual(requests);

    // And that first pass was the one corrective pass this run had. The second
    // all-attached request buys nothing: the loop stops re-running research and
    // the run plans with the repositories it already holds. Three more rounds
    // of the same request used to follow, and then a dead run.
    const second = advanceExpansion(ctx, requests, ctx.selectedRepositories);
    expect(second.action).toEqual({ kind: "plan_without" });
    expect(ctx.repositoryExpansion.expansionClosed).toBeUndefined();

    // It stays that way however many times the model asks.
    expect(advanceExpansion(ctx, requests, ctx.selectedRepositories).action).toEqual({
      kind: "plan_without",
    });
  });

  // Research asking for more context without naming any repository used to
  // park the whole run on "Which repository is required?", which no human can
  // answer: the model itself could not name one.
  it("continues without a clarification when no repository is named, for one pass", () => {
    const ctx = makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: { version: 2, repositories: [] },
      selectedRepositories: [
        {
          provider: "github",
          repoPath: "acme/service",
          defaultBranch: "main",
          selectedRationale: "symptom",
        },
      ],
    });

    const first = advanceExpansion(ctx, [], ctx.selectedRepositories);
    // The run keeps going: no clarification, and nothing to clone.
    expect(first.verdict).toEqual({ kind: "unnamed_request" });
    expect(first.action).toEqual({ kind: "proceed" });
    expect(ctx.repositoryExpansion.rounds).toBe(1);
    // Not an all-attached request, so the streak that closes expansion is
    // untouched: the round limit is what bounds this one.
    expect(ctx.repositoryExpansion.allAttachedRequests).toBeUndefined();

    // A pass that asked for nothing at all is as spent as one that asked for a
    // repository it cannot have, so it draws on the same single corrective
    // pass: the second one does not buy a third.
    expect(advanceExpansion(ctx, [], ctx.selectedRepositories).action).toEqual({
      kind: "plan_without",
    });
  });
});

describe("research phase identity across re-runs", () => {
  // Every pass that re-runs research inside one planning block has to be
  // distinguishable, or the second pass writes over the first one's artifacts
  // and its launch sentinel reads as already launched. The passes after
  // expansion closes repeat without advancing the round count, which is exactly
  // the collision this suffix removes (AIW-377).
  const base = { nodeId: "plan", artifactPhase: "research", noChangeRetry: false };

  it("names the first pass after the node alone", () => {
    expect(
      researchPhaseIdentity({ ...base, expansion: { rounds: 0 } }),
    ).toEqual({ label: "Research plan", artifactPhase: "research" });
  });

  it("names an expansion round", () => {
    expect(
      researchPhaseIdentity({ ...base, expansion: { rounds: 2 } }),
    ).toEqual({
      label: "Research plan expansion 2",
      artifactPhase: "research-expansion-2",
    });
  });

  it("separates the passes that follow a closed expansion", () => {
    const first = researchPhaseIdentity({
      ...base,
      expansion: { rounds: 3, expansionClosed: "bound" },
    });
    const second = researchPhaseIdentity({
      ...base,
      expansion: { rounds: 3, expansionClosed: "bound", closedRequests: 1 },
    });

    // A pass that absorbed nothing says "closed", not "closed 0": the count is
    // engine bookkeeping and a person reads this label.
    expect(first).toEqual({
      label: "Research plan expansion 3 closed",
      artifactPhase: "research-expansion-3-closed",
    });
    expect(second.label).not.toBe(first.label);
    expect(second.artifactPhase).not.toBe(first.artifactPhase);
  });

  it("separates the pass after a human closes expansion from the pass before it", () => {
    // A human answering "no further repositories" closes expansion without
    // advancing the round count, so dropping the suffix entirely would give the
    // re-run the identity of the pass that asked the question.
    const before = researchPhaseIdentity({ ...base, expansion: { rounds: 0 } });
    const after = researchPhaseIdentity({
      ...base,
      expansion: { rounds: 0, expansionClosed: "human" },
    });

    expect(after).toEqual({
      label: "Research plan closed",
      artifactPhase: "research-closed",
    });
    expect(after.label).not.toBe(before.label);
    expect(after.artifactPhase).not.toBe(before.artifactPhase);
  });

  it("separates the pass after a human attach from the pass that asked for it", () => {
    // The model hit the round limit and the run parked. A human answer that
    // attaches a repository changes nothing the identity was built from: the
    // round count stays put (this attach never counts a model round) and
    // expansion stays open. Without a suffix of its own the resumed pass
    // recomputes the identity of the pass that asked, whose artifacts it then
    // writes over and whose launch sentinel reads as already launched. The
    // attempt number cannot separate them: it is fixed per execution
    // (AIW-400).
    const asking = { rounds: 2, priorRequests: [] };
    const attachedAlready = [{ provider: "github" as const, repoPath: "acme/service" }];
    const parked = validateRepositoryExpansionRequests({
      requests: [
        { provider: "gitlab", repoPath: "acme/shared/contracts", rationale: "late" },
      ],
      catalog,
      attached: attachedAlready,
      completedRounds: asking.rounds,
    });
    expect(parked.kind).toBe("clarification_needed");

    const { action, state: resumedState } = decideRepositoryExpansion({
      origin: "human",
      verdict: validateHumanRepositoryExpansion({
        answer: "gitlab:acme/shared/contracts",
        catalog,
        attached: attachedAlready,
      }),
      state: asking,
      clarificationRounds: 1,
    });
    expect(action.kind).toBe("attach");
    expect(resumedState.rounds).toBe(asking.rounds);
    expect(resumedState.humanAttachRound).toBe(1);

    const askingIdentity = researchPhaseIdentity({ ...base, expansion: asking });
    const resumedIdentity = researchPhaseIdentity({ ...base, expansion: resumedState });

    expect(askingIdentity).toEqual({
      label: "Research plan expansion 2",
      artifactPhase: "research-expansion-2",
    });
    expect(resumedIdentity).toEqual({
      label: "Research plan expansion 2 human attach 1",
      artifactPhase: "research-expansion-2-human-attach-1",
    });
  });

  it("moves the human attach suffix on a second human attach in the same run", () => {
    // Two attaches in one run are two more research passes, and the second one
    // is reached through a later clarification round, so the suffix it carries
    // has to be a different one.
    const attachedAlready = [{ provider: "github" as const, repoPath: "acme/service" }];
    const attach = (state: { rounds: number; priorRequests: [] }, clarificationRounds: number) =>
      decideRepositoryExpansion({
        origin: "human",
        verdict: validateHumanRepositoryExpansion({
          answer: "gitlab:acme/shared/contracts",
          catalog,
          attached: attachedAlready,
        }),
        state,
        clarificationRounds,
      }).state;

    const first = attach({ rounds: 1, priorRequests: [] }, 1);
    const second = attach({ rounds: 1, priorRequests: [] }, 3);

    expect(first.humanAttachRound).toBe(1);
    expect(second.humanAttachRound).toBe(3);
    expect(researchPhaseIdentity({ ...base, expansion: second })).toEqual({
      label: "Research plan expansion 1 human attach 3",
      artifactPhase: "research-expansion-1-human-attach-3",
    });
    expect(researchPhaseIdentity({ ...base, expansion: first }).artifactPhase).not.toBe(
      researchPhaseIdentity({ ...base, expansion: second }).artifactPhase,
    );
  });

  it("adds nothing to a run where no human ever attached a repository", () => {
    // The suffix is new, so every identity a run without a human attach can
    // produce has to be exactly what it was before (AIW-400).
    expect(researchPhaseIdentity({ ...base, expansion: { rounds: 0 } })).toEqual({
      label: "Research plan",
      artifactPhase: "research",
    });
    expect(
      researchPhaseIdentity({ ...base, expansion: { rounds: 2, humanAttachRound: 0 } }),
    ).toEqual({
      label: "Research plan expansion 2",
      artifactPhase: "research-expansion-2",
    });
    expect(
      researchPhaseIdentity({
        ...base,
        expansion: { rounds: 3, expansionClosed: "bound", closedRequests: 1 },
      }),
    ).toEqual({
      label: "Research plan expansion 3 closed 1",
      artifactPhase: "research-expansion-3-closed-1",
    });
  });

  it("keeps the no-change retry suffix last", () => {
    expect(
      researchPhaseIdentity({
        nodeId: "plan",
        artifactPhase: "research-v2-a-a1",
        expansion: { rounds: 1, expansionClosed: "human", closedRequests: 1 },
        noChangeRetry: true,
      }),
    ).toEqual({
      label: "Research plan expansion 1 closed 1 no-change retry",
      artifactPhase: "research-v2-a-a1-expansion-1-closed-1-no-change-retry",
    });
  });
});
