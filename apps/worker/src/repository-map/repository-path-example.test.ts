import { describe, expect, it, vi } from "vitest";
import type { IntegrationManifest } from "@integrations/sdk";

/**
 * What a person, and a model, is told a repository is called.
 *
 * Seven sentences showed `github:acme/app` as the example of a provider-scoped
 * path. They are read where being wrong is expensive: the ticket comment
 * somebody answers, and the prompt a research agent answers from. On a
 * deployment that connected GitLab and no GitHub the example named a provider
 * that is not there, and an answer written to match it is refused.
 *
 * So the registry is driven here, not this build's own two providers: `forgejo`
 * is an id core contains nowhere. A surviving literal passes against a registry
 * that still holds GitHub and fails against this one.
 */

const forgejo = {
  id: "forgejo",
  name: "Forgejo",
  description: "A provider this build has never heard of.",
  connection: { fields: [] },
  capabilities: ["vcs"],
  blocks: [],
  pages: [],
  health: [],
  repositories: { host: "code.example.org" },
} as unknown as IntegrationManifest;

const second = { ...forgejo, id: "second", name: "Second" } as IntegrationManifest;

/** A provider whose repositories are always exactly `owner/name`, which is the
 *  other depth a path can have and the one a nested example would get wrong. */
const flat = {
  ...forgejo,
  id: "flatly",
  name: "Flatly",
  repositories: { host: "flat.example.org", nestedPaths: false },
} as unknown as IntegrationManifest;

/** The version control integrations the build under test ships. */
const shipped = vi.hoisted(() => ({ vcs: [] as unknown[] }));

// Only the capability answer is replaced. The rest of the registry stays real,
// so a module reached through these call sites still sees the build it is in.
vi.mock("@integrations/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@integrations/registry")>();
  return {
    ...actual,
    integrationsProviding: (capability: string) =>
      capability === "vcs"
        ? (shipped.vcs as IntegrationManifest[])
        : actual.integrationsProviding(capability),
  };
});

const { exampleRepositoryPath } = await import("./repository-path-example.js");
const { validateRepositoryExpansionRequests } = await import(
  "../engine/repository-discovery/runner.js"
);
const { formatAnswerAlsoNamedComment, formatAnswerNotRecordedComment } = await import(
  "../engine/support/clarification-comment-format.js"
);
const { validateRepositoryDiscoveryResult } = await import(
  "../engine/repository-discovery/protocol.js"
);
const { selectRepositoriesFromMetadata } = await import(
  "../engine/pre-sandbox/steps/repo-selection.js"
);
const { assembleResearchPlanContext } = await import("../sandbox/context.js");

function catalogEntry(repoPath: string) {
  return {
    provider: "forgejo",
    repoPath,
    name: repoPath.split("/").at(-1) ?? "",
    defaultBranch: "main",
    description: "Web application",
    topics: [],
    relationships: [],
    usable: true,
  };
}

function repositoryMetadata(repoPath: string) {
  return {
    provider: "forgejo",
    repoPath,
    name: repoPath.split("/").at(-1) ?? "",
    owner: repoPath.split("/")[0] ?? "",
    defaultBranch: "main",
    description: "Billing API and webhook handlers",
    webUrl: `https://code.example.org/${repoPath}`,
    topics: [],
    archived: false,
    private: true,
  };
}

describe("the example repository path a sentence shows", () => {
  it("is scoped to a version control provider this build ships", () => {
    shipped.vcs = [forgejo];
    expect(exampleRepositoryPath("acme/app")).toBe("forgejo:acme/app");
    expect(exampleRepositoryPath("owner/repo")).toBe("forgejo:owner/repo");
  });

  it("takes the first, so a deployment with several is shown one real shape", () => {
    shipped.vcs = [forgejo, second];
    expect(exampleRepositoryPath("acme/app")).toBe("forgejo:acme/app");
  });

  it("says provider where a build ships none, rather than a bare colon", () => {
    shipped.vcs = [];
    expect(exampleRepositoryPath("acme/app")).toBe("provider:acme/app");
  });
});

describe("the sentences that teach somebody how to name a repository", () => {
  it("asks for a path under a provider this deployment has, in a comment", () => {
    shipped.vcs = [forgejo];
    const body = formatAnswerNotRecordedComment("no_words", {
      listedCount: 0,
      aLaterRunCanPickThemUp: false,
      commentPath: "unproven",
    });
    expect(body).toContain(
      "Write the full path of the repository this work should use in a comment here," +
        " for example forgejo:acme/app,",
    );
    expect(body).not.toContain("github");
  });

  it("shows the same provider when a name matched nothing, singular and plural", () => {
    shipped.vcs = [forgejo];
    expect(
      formatAnswerAlsoNamedComment({
        added: [],
        notEnabled: [],
        unmatched: ["forgejo:acme/does-not-exist"],
      }),
    ).toContain(
      "A repository is matched by its full path, such as forgejo:acme/app: check how it was written",
    );
    expect(
      formatAnswerAlsoNamedComment({
        added: [],
        notEnabled: [],
        unmatched: ["forgejo:acme/one", "forgejo:acme/two"],
      }),
    ).toContain(
      "A repository is matched by its full path, such as forgejo:acme/app: check how they were written",
    );
  });

  it("asks a person to choose between candidates in the paths this build understands", () => {
    shipped.vcs = [forgejo];
    const decision = validateRepositoryDiscoveryResult(
      {
        status: "selected",
        confidence: "low",
        repositories: [
          {
            provider: "forgejo",
            repoPath: "acme/app",
            rationale: "the ticket names the app",
          },
        ],
        questions: null,
        error: null,
      },
      [catalogEntry("acme/app")],
      [],
    );
    expect(decision.kind).toBe("clarification_needed");
    // No example any more, and that is the stronger answer: the question names
    // the candidate itself, so the person types a key that exists on this
    // deployment rather than one modelled on an example. What still must never
    // appear is another provider's shape, or the word "provider" standing in
    // for one.
    const question = decision.kind === "clarification_needed" ? decision.questions[0] ?? "" : "";
    expect(question).toContain("forgejo:acme/app");
    expect(question).not.toContain("github:");
    expect(question).not.toContain("provider:owner");
  });

  it("names a repository the run already knows ahead of any example", () => {
    // The preference this sentence has always had: where the run holds a real
    // key, it shows that key, because a person copying it attaches something.
    shipped.vcs = [forgejo];
    const decision = validateRepositoryDiscoveryResult(
      {
        status: "selected",
        confidence: "low",
        repositories: [
          {
            provider: "forgejo",
            repoPath: "acme/app",
            rationale: "the ticket names the app",
          },
        ],
        questions: null,
        error: null,
      },
      [catalogEntry("acme/app")],
      [],
      {
        answerLeftUnnamed: [],
        answeredRepositoryKeys: ["forgejo:acme/app"],
        commentPathIsTaken: () => true,
        recorded: [],
      },
    );
    expect(decision.kind).toBe("failed");
    expect(decision.kind === "failed" && decision.error).toContain(
      "in a comment on this ticket, as forgejo:acme/app, and start a new run.",
    );
  });

  it("tells a person whose previous answer named nothing usable how to write one", () => {
    shipped.vcs = [forgejo];
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Change the billing callback.",
      repositories: [repositoryMetadata("acme/api")],
      workflowOwnedBranches: [],
      directAnswer: "use forgejo:acme/missing please",
    });
    expect(selected.status).toBe("clarification_needed");
    expect(selected.status === "clarification_needed" && selected.questions[0]).toContain(
      'or as "forgejo:owner/repo" to pin the provider.',
    );
  });

  it("never shows the other provider's example when the build ships two", () => {
    // The whole defect in one case: the registry ships both, the deployment
    // works on one, and every sentence below is read where naming the wrong
    // one costs a round of questions or a refused answer.
    shipped.vcs = [flat, forgejo];

    const comment = formatAnswerAlsoNamedComment({
      added: [],
      notEnabled: [],
      unmatched: ["forgejo:acme/does-not-exist"],
    });
    expect(comment).toContain("such as forgejo:acme/app");
    expect(comment).not.toContain("flatly");

    const context = assembleResearchPlanContext({
      ticket: {
        identifier: "AIW-147",
        title: "Research repositories",
        description: "Trace ownership",
        acceptanceCriteria: "",
        comments: [],
      },
      prompt: "Legacy output format.",
      branchName: "ai-workflow/aiw-147",
      selectedRepositories: [
        {
          provider: "forgejo",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "the ticket names it",
        },
      ],
    });
    expect(context).toContain("forgejo:acme/api src/auth.ts:42");
    expect(context).not.toContain("flatly");

    const selected = selectRepositoriesFromMetadata({
      ticketText: "Change the billing callback.",
      repositories: [repositoryMetadata("acme/api")],
      workflowOwnedBranches: [],
      directAnswer: "use forgejo:acme/missing please",
    });
    expect(selected.status).toBe("clarification_needed");
    expect(selected.status === "clarification_needed" && selected.questions[0]).toContain(
      'or as "forgejo:owner/repo" to pin the provider.',
    );
    expect(selected.status === "clarification_needed" && selected.questions[0]).not.toContain(
      "flatly",
    );
  });

  it("shows a research agent the evidence format under a provider it can reach", () => {
    shipped.vcs = [forgejo];
    const context = assembleResearchPlanContext({
      ticket: {
        identifier: "AIW-147",
        title: "Research repositories",
        description: "Trace ownership",
        acceptanceCriteria: "",
        comments: [],
      },
      prompt: "Legacy output format.",
      branchName: "ai-workflow/aiw-147",
    });
    expect(context).toContain("forgejo:acme/api src/auth.ts:42");
  });
});

/**
 * The one sentence that teaches the FORMAT rather than showing an instance of
 * it: the expansion clarification, which is rendered into a ticket comment and
 * answered by typing a path.
 *
 * It used to read `reply with exact repository paths as "provider:owner/repo"`.
 * A person copying that names a provider called `provider` and the catalog
 * refuses the answer, which costs another round of the loop these questions
 * exist to end.
 *
 * WHAT THE REGISTRY SHIPS IS NOT WHAT THE DEPLOYMENT CONNECTED. This build
 * ships two version control integrations and most deployments connect one, so
 * an example read off the registry offers a provider whose repositories the
 * person cannot name, and the catalog refuses the answer it invited. The
 * catalog in hand is the honest source: every entry in it came from a provider
 * that answered.
 */
describe("the answer format an expansion clarification states", () => {
  function expansionLimitQuestion(
    catalog: ReturnType<typeof catalogEntry>[] = [catalogEntry("acme/api")],
  ): string {
    const decision = validateRepositoryExpansionRequests({
      requests: [{ provider: "forgejo", repoPath: "acme/api", rationale: "late" }],
      catalog,
      attached: [],
      completedRounds: 2,
    });
    if (decision.kind !== "clarification_needed") {
      throw new Error(`expected a clarification, got ${decision.kind}`);
    }
    return decision.questions[0] ?? "";
  }

  it("shows a path under the provider whose repositories are on offer", () => {
    shipped.vcs = [forgejo];
    const question = expansionLimitQuestion();
    expect(question).toContain('reply with exact repository paths as "forgejo:group/repo"');
    expect(question).not.toContain("provider:owner/repo");
  });

  it("offers no provider the catalog does not hold, whatever the build ships", () => {
    // The defect this exists for: a build shipping two providers and a
    // deployment connected to one. The other one's example is an answer the
    // catalog refuses.
    shipped.vcs = [flat, forgejo];

    const question = expansionLimitQuestion([catalogEntry("acme/api")]);

    expect(question).toContain('as "forgejo:group/repo"');
    expect(question).not.toContain("flatly");
  });

  it("shows each provider at its own depth when the catalog holds both", () => {
    shipped.vcs = [flat, forgejo];

    const question = expansionLimitQuestion([
      { ...catalogEntry("acme/api"), provider: "flatly" },
      catalogEntry("acme/web"),
    ]);

    expect(question).toContain(
      'reply with exact repository paths as "flatly:owner/repo" or "forgejo:group/repo"',
    );
  });

  it("lists every provider on offer, so no reachable one reads as unavailable", () => {
    shipped.vcs = [flat, forgejo, second];

    const question = expansionLimitQuestion([
      { ...catalogEntry("acme/api"), provider: "flatly" },
      catalogEntry("acme/web"),
      { ...catalogEntry("acme/docs"), provider: "second" },
    ]);

    expect(question).toContain(
      'as "flatly:owner/repo", "forgejo:group/repo" or "second:group/repo"',
    );
  });

  it("falls back to what the build ships when the catalog is empty", () => {
    // Nothing on offer says nothing about the deployment, so the build's own
    // providers are the only honest guess left.
    shipped.vcs = [forgejo];

    expect(expansionLimitQuestion([])).toContain('as "forgejo:group/repo"');
  });

  it("says provider only where a build ships none at all", () => {
    shipped.vcs = [];

    expect(expansionLimitQuestion([])).toContain(
      'reply with exact repository paths as "provider:owner/repo"',
    );
  });
});
