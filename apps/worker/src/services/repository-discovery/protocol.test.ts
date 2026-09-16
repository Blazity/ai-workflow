import type { WorkScopeEntry } from "@shared/contracts";
import { describe, expect, it } from "vitest";
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import type { RepositoryCatalogEntry } from "./catalog.js";
import {
  repositoryDiscoveryQuestion,
  validateRepositoryDiscoveryResult,
} from "./protocol.js";

const catalog: RepositoryCatalogEntry[] = [
  {
    provider: "github",
    repoPath: "acme/app",
    name: "app",
    defaultBranch: "main",
    description: "Web application",
    topics: ["frontend"],
    relationships: [],
    usable: true,
  },
  {
    provider: "gitlab",
    repoPath: "group/shared",
    name: "shared",
    defaultBranch: "main",
    description: "Shared components",
    topics: [],
    relationships: [],
    usable: true,
  },
];

const mandatory: SelectedRepository[] = [
  {
    provider: "github",
    repoPath: "acme/app",
    defaultBranch: "main",
    selectedRationale: "PR trigger repository",
  },
];

/** What a person is asked when the catalog does not hold the repository the
 *  model proposed. Written out rather than built, so a change to a sentence a
 *  person reads shows up as a change to this file. */
const UNAVAILABLE_QUESTION =
  "Which repository or repositories should this ticket inspect or modify?" +
  " Reply with full repository paths." +
  " Enable it on the Repositories page, or answer with another repository.";

describe("validateRepositoryDiscoveryResult", () => {
  it("accepts high-confidence catalog identities and force-includes mandatory repositories", () => {
    expect(validateRepositoryDiscoveryResult({
      status: "selected",
      confidence: "high",
      repositories: [
        {
          provider: "gitlab",
          repoPath: "GROUP/SHARED",
          rationale: "Ticket references shared UI primitives",
        },
      ],
      questions: null,
      error: null,
    }, catalog, mandatory)).toEqual({
      kind: "selected",
      repositories: [
        mandatory[0],
        {
          provider: "gitlab",
          repoPath: "group/shared",
          defaultBranch: "main",
          selectedRationale: "Ticket references shared UI primitives",
        },
      ],
      confidence: "high",
    });
  });

  it.each([
    ["low confidence", {
      status: "selected",
      confidence: "low",
      repositories: [{ provider: "github", repoPath: "acme/app", rationale: "guess" }],
      questions: null,
      error: null,
    }],
    ["unknown repository", {
      status: "selected",
      confidence: "high",
      repositories: [{ provider: "github", repoPath: "acme/secret", rationale: "guess" }],
      questions: null,
      error: null,
    }],
    ["duplicate identity", {
      status: "selected",
      confidence: "high",
      repositories: [
        { provider: "github", repoPath: "acme/app", rationale: "one" },
        { provider: "github", repoPath: "ACME/APP", rationale: "two" },
      ],
      questions: null,
      error: null,
    }],
    ["invalid schema", { status: "selected", confidence: "high", repositories: [] }],
  ])("falls back to clarification for %s", (_label, raw) => {
    expect(validateRepositoryDiscoveryResult(raw, catalog, [])).toMatchObject({
      kind: "clarification_needed",
    });
  });

  it("falls back to clarification when a high-confidence selection targets an unusable catalog repository", () => {
    // Archived repositories never reach the protocol (buildRepositoryCatalog drops
    // them, covered in catalog.test.ts). A repository with no default branch DOES
    // reach it, flagged usable:false, and must be rejected here rather than
    // attached.
    const catalogWithUnusable: RepositoryCatalogEntry[] = [
      ...catalog,
      {
        provider: "github",
        repoPath: "acme/uninitialized",
        name: "uninitialized",
        defaultBranch: "",
        description: "No default branch yet",
        topics: [],
        relationships: [],
        usable: false,
        unusableReason: "missing_default_branch",
      },
    ];
    expect(
      validateRepositoryDiscoveryResult(
        {
          status: "selected",
          confidence: "high",
          repositories: [
            { provider: "github", repoPath: "acme/uninitialized", rationale: "guess" },
          ],
          questions: null,
          error: null,
        },
        catalogWithUnusable,
        [],
      ),
    ).toMatchObject({ kind: "clarification_needed" });
  });

  it("does not gate the allowlist itself; off-allowlist filtering happens downstream at attach and publish", () => {
    // The discovery protocol has no allowlist parameter, and the catalog handed to
    // it (buildRepositoryCatalog) is not allowlist-filtered, so an off-allowlist
    // repository present on the catalog is admitted here. It is blocked downstream
    // instead: at attachResearchRepositoriesStep (agent.ts, isRepoAllowed re-check
    // before any clone), in validateHumanRepositoryExpansion (isAllowed, covered in
    // runner.test.ts) for human answers, and again at push in the trusted workspace
    // publisher. This test documents that layering: selection is a catalog concern,
    // not an allowlist concern.
    expect(
      validateRepositoryDiscoveryResult(
        {
          status: "selected",
          confidence: "high",
          repositories: [
            {
              provider: "github",
              repoPath: "acme/app",
              rationale: "on catalog; allowlist is enforced later, not here",
            },
          ],
          questions: null,
          error: null,
        },
        catalog,
        [],
      ),
    ).toMatchObject({
      kind: "selected",
      repositories: [{ provider: "github", repoPath: "acme/app" }],
    });
  });

  it("turns medium confidence into a clarification listing every proposed candidate", () => {
    const decision = validateRepositoryDiscoveryResult({
      status: "selected",
      confidence: "medium",
      repositories: [
        { provider: "github", repoPath: "acme/app", rationale: "ticket names the app" },
        { provider: "gitlab", repoPath: "group/shared", rationale: "shared UI primitives" },
      ],
      questions: null,
      error: null,
    }, catalog, []);
    expect(decision.kind).toBe("clarification_needed");
    if (decision.kind === "clarification_needed") {
      const [question] = decision.questions;
      expect(question).toContain("github:acme/app");
      expect(question).toContain("ticket names the app");
      expect(question).toContain("gitlab:group/shared");
      expect(question).toContain("shared UI primitives");
    }
  });

  it("keeps the proposed candidates in a low-confidence clarification", () => {
    const decision = validateRepositoryDiscoveryResult({
      status: "selected",
      confidence: "low",
      repositories: [
        { provider: "github", repoPath: "acme/app", rationale: "weak guess" },
      ],
      questions: null,
      error: null,
    }, catalog, []);
    expect(decision.kind).toBe("clarification_needed");
    if (decision.kind === "clarification_needed") {
      expect(decision.questions[0]).toContain("github:acme/app");
      expect(decision.questions[0]).toContain("weak guess");
    }
  });

  it("rejects more than three discovered repositories", () => {
    const largeCatalog = Array.from({ length: 4 }, (_, index) => ({
      ...catalog[0],
      repoPath: `acme/app-${index}`,
    }));
    expect(validateRepositoryDiscoveryResult({
      status: "selected",
      confidence: "medium",
      repositories: largeCatalog.map((entry) => ({
        provider: entry.provider,
        repoPath: entry.repoPath,
        rationale: "related",
      })),
      questions: null,
      error: null,
    }, largeCatalog, [])).toMatchObject({ kind: "clarification_needed" });
  });

  it("says which repository it could not use, and why, so the question can carry it", () => {
    // The sentence and the hint are unchanged; what is new is that the decision
    // now names the repository it is about. Without that the clarification row
    // carries no repository, the answer path writes nothing, and the next run
    // asks the same person the same thing.
    expect(
      validateRepositoryDiscoveryResult(
        {
          status: "selected",
          confidence: "high",
          repositories: [
            {
              provider: "github",
              repoPath: "acme/secret",
              rationale: "the ticket names the billing service",
            },
          ],
          questions: null,
          error: null,
        },
        catalog,
        [],
      ),
    ).toEqual({
      kind: "clarification_needed",
      questions: [UNAVAILABLE_QUESTION],
      reason: "Repository discovery requested an unavailable repository.",
      refused: [
        {
          repositoryKey: "github:acme/secret",
          reason: "not_enabled",
          rationale: "the ticket names the billing service",
        },
      ],
    });
  });

  it("tells a repository the catalog cannot use apart from one it does not hold", () => {
    // The two answer to different things: a person can enable the first and
    // never the second, and a "none" to each is recorded under its own reason.
    const catalogWithUnusable: RepositoryCatalogEntry[] = [
      ...catalog,
      {
        provider: "github",
        repoPath: "acme/uninitialized",
        name: "uninitialized",
        defaultBranch: "",
        description: "No default branch yet",
        topics: [],
        relationships: [],
        usable: false,
        unusableReason: "missing_default_branch",
      },
    ];

    expect(
      validateRepositoryDiscoveryResult(
        {
          status: "selected",
          confidence: "high",
          repositories: [
            {
              provider: "github",
              repoPath: "acme/uninitialized",
              rationale: "the ticket names the new service",
            },
          ],
          questions: null,
          error: null,
        },
        catalogWithUnusable,
        [],
      ),
    ).toMatchObject({
      refused: [
        {
          repositoryKey: "github:acme/uninitialized",
          reason: "unusable",
          rationale: "the ticket names the new service",
        },
      ],
    });
  });

  it("names nothing for a path the model invented that is not a repository at all", () => {
    // A question can only name what the record can hold. Prose where a path
    // belongs names nothing, so the question carries nothing and behaves as it
    // always did rather than writing a key nothing can read back.
    expect(
      validateRepositoryDiscoveryResult(
        {
          status: "selected",
          confidence: "high",
          repositories: [
            {
              provider: "github",
              repoPath: "the billing service",
              rationale: "guess",
            },
          ],
          questions: null,
          error: null,
        },
        catalog,
        [],
      ),
    ).toEqual({
      kind: "clarification_needed",
      questions: [UNAVAILABLE_QUESTION],
      reason: "Repository discovery requested an unavailable repository.",
      refused: [],
    });
  });

  it("names no repository on a duplicate proposal, which is the model breaking the protocol", () => {
    expect(
      validateRepositoryDiscoveryResult(
        {
          status: "selected",
          confidence: "high",
          repositories: [
            { provider: "github", repoPath: "acme/app", rationale: "one" },
            { provider: "github", repoPath: "ACME/APP", rationale: "two" },
          ],
          questions: null,
          error: null,
        },
        catalog,
        [],
      ),
    ).toMatchObject({
      reason: "Repository discovery returned duplicate repositories.",
      refused: [],
    });
  });

  it.each([
    ["an invalid response", { status: "selected", confidence: "high", repositories: [] }],
    [
      "a model that asked for clarification itself",
      { status: "clarification_needed", confidence: null, repositories: null, questions: null, error: null },
    ],
    [
      "confidence too low to select",
      {
        status: "selected",
        confidence: "low",
        repositories: [{ provider: "github", repoPath: "acme/app", rationale: "weak guess" }],
        questions: null,
        error: null,
      },
    ],
  ])("names no repository on %s", (_label, raw) => {
    expect(validateRepositoryDiscoveryResult(raw, catalog, [])).toMatchObject({
      kind: "clarification_needed",
      refused: [],
    });
  });

  it("rejects a combined mandatory and discovered selection above three repositories", () => {
    const largeCatalog = Array.from({ length: 4 }, (_, index) => ({
      ...catalog[0],
      repoPath: `acme/app-${index}`,
    }));
    const required = largeCatalog.slice(0, 2).map((entry) => ({
      provider: entry.provider,
      repoPath: entry.repoPath,
      defaultBranch: entry.defaultBranch,
      selectedRationale: "workflow-owned branch",
    }));

    expect(validateRepositoryDiscoveryResult({
      status: "selected",
      confidence: "high",
      repositories: largeCatalog.slice(2).map((entry) => ({
        provider: entry.provider,
        repoPath: entry.repoPath,
        rationale: "related",
      })),
      questions: null,
      error: null,
    }, largeCatalog, required)).toMatchObject({ kind: "clarification_needed" });
  });
});

/**
 * The question a person actually reads, and what it records itself against.
 *
 * Discovery runs the agent once and its proposal is final, so unlike the
 * expansion there is no turn in which the model can be refused and try again:
 * every disagreement here reaches a person or nobody. The whole decision lives
 * in this function rather than in the workflow closure that calls it, because a
 * closure inside a `"use workflow"` body cannot be invoked by a test, and a
 * decision no test can reach is one that can be reverted without a test going
 * red.
 */
describe("repositoryDiscoveryQuestion", () => {
  const SUBJECT = "ticket:jira:AWT-1";

  const PERSON = {
    kind: "person" as const,
    actorId: "u-1",
    actorLabel: "Ada Lovelace",
  };

  function excludedEntry(repositoryKey: string): WorkScopeEntry {
    return {
      repositoryKey,
      state: "excluded",
      origin: "person",
      rationale: "not part of this ticket",
      decidedBy: PERSON,
      decidedAt: "2026-09-10T08:30:00.000Z",
    };
  }

  function refusedDiscovery(repositoryKey: string, rationale: string) {
    return {
      kind: "clarification_needed" as const,
      questions: [UNAVAILABLE_QUESTION],
      reason: "Repository discovery requested an unavailable repository.",
      refused: [{ repositoryKey, reason: "not_enabled" as const, rationale }],
    };
  }

  /** The ordinary call: a record that holds the exclusion, and a catalog that
   *  still holds the repository. */
  function askAbout(
    repositoryKey: string,
    rationale: string,
    options: {
      recorded?: WorkScopeEntry[];
      catalog?: RepositoryCatalogEntry[];
      subjectKey?: string | null;
    } = {},
  ) {
    return repositoryDiscoveryQuestion({
      decision: refusedDiscovery(repositoryKey, rationale),
      subjectKey: options.subjectKey === undefined ? SUBJECT : options.subjectKey,
      recorded: options.recorded ?? [excludedEntry(repositoryKey)],
      catalog: options.catalog ?? catalog,
    });
  }

  it("tells a person who excluded the repository, when, and what answering with it will do", () => {
    expect(askAbout("github:acme/app", "the ticket names the billing service")).toEqual({
      questions: [
        "github:acme/app was excluded on this work by Ada Lovelace on 2026-09-10." +
          ' Repository discovery asked for it anyway, because "the ticket names the billing service".' +
          " Answer with github:acme/app to take that exclusion back and let this run use it," +
          " or with the repositories this ticket should use instead.",
      ],
      ask: {
        subjectKey: SUBJECT,
        askedRepositories: [{ repositoryKey: "github:acme/app", askedBecause: "selection" }],
      },
    });
  });

  it("never tells a person to enable a repository that is already enabled", () => {
    // The enable hint is true for a repository the catalog does not hold and
    // false in every part for one a person took off this work: it is enabled,
    // it is usable, and the only thing between the run and it is their own
    // decision.
    const { questions } = askAbout("github:acme/app", "the ticket names the billing service");

    expect(questions.join(" ")).not.toContain("Enable");
    expect(questions.join(" ")).not.toContain("Repositories page");
  });

  it("says a run made the exclusion when a run made it", () => {
    const { questions } = askAbout("github:acme/app", "the ticket names it", {
      recorded: [
        {
          ...excludedEntry("github:acme/app"),
          origin: "ticket_text",
          decidedBy: { kind: "run", runId: "run-7", definitionId: 1, definitionVersion: 4 },
        },
      ],
    });

    expect(questions[0]).toContain("by run run-7 on 2026-09-10.");
  });

  it("does not promise back a repository that has left the catalog", () => {
    // The person excluded it; later it was disabled on the Repositories page or
    // deleted at the provider. Promising it back would destroy their own
    // decision and buy nothing: the same run refuses the key as outside the
    // catalog and asks the enable question anyway. Today's sentence is the true
    // one in that state.
    expect(
      askAbout("github:acme/gone", "the ticket names it", {
        recorded: [excludedEntry("github:acme/gone")],
      }),
    ).toEqual({
      questions: [UNAVAILABLE_QUESTION],
      ask: {
        subjectKey: SUBJECT,
        askedRepositories: [{ repositoryKey: "github:acme/gone", askedBecause: "not_enabled" }],
      },
    });
  });

  it("does not promise back a repository the catalog holds and cannot use", () => {
    // Answering with it would record a selection the run still cannot act on,
    // and the hint is what actually helps: the repository needs a default
    // branch before anything can use it.
    const withUnusable: RepositoryCatalogEntry[] = [
      ...catalog,
      {
        provider: "github",
        repoPath: "acme/uninitialized",
        name: "uninitialized",
        defaultBranch: "",
        description: "No default branch yet",
        topics: [],
        relationships: [],
        usable: false,
        unusableReason: "missing_default_branch",
      },
    ];

    expect(
      askAbout("github:acme/uninitialized", "the ticket names it", {
        catalog: withUnusable,
        recorded: [excludedEntry("github:acme/uninitialized")],
      }).questions,
    ).toEqual([UNAVAILABLE_QUESTION]);
  });

  it("keeps the validator's own sentence for a repository the record decided nothing about", () => {
    // The enable hint is the truth here, and a run that reads a record must not
    // start telling a different story about the ordinary case.
    expect(
      askAbout("github:acme/secret", "a guess", {
        recorded: [excludedEntry("github:acme/app")],
      }),
    ).toEqual({
      questions: [UNAVAILABLE_QUESTION],
      ask: {
        subjectKey: SUBJECT,
        askedRepositories: [{ repositoryKey: "github:acme/secret", askedBecause: "not_enabled" }],
      },
    });
  });

  it("keeps the validator's own sentence for a repository the record only recorded as unavailable", () => {
    // Only an EXCLUSION is somebody's decision to take back. An unavailable
    // entry says the deployment could not offer it, which is what the hint
    // already tells the person how to fix.
    expect(
      askAbout("github:acme/app", "a guess", {
        recorded: [
          {
            ...excludedEntry("github:acme/app"),
            state: "unavailable",
            unavailableReason: "not_enabled",
          },
        ],
      }).questions,
    ).toEqual([UNAVAILABLE_QUESTION]);
  });

  it("asks about no repository when the clarification is about none", () => {
    // The duplicate proposal and the confidence clarifications are about the
    // model's behaviour, not about a repository, so there is nothing an answer
    // could be recorded against.
    expect(
      repositoryDiscoveryQuestion({
        decision: {
          kind: "clarification_needed",
          questions: ["Which repository or repositories should this ticket inspect or modify?"],
          reason: "Repository discovery returned duplicate repositories.",
          refused: [],
        },
        subjectKey: SUBJECT,
        recorded: [excludedEntry("github:acme/app")],
        catalog,
      }),
    ).toEqual({
      questions: ["Which repository or repositories should this ticket inspect or modify?"],
      ask: null,
    });
  });

  it("claims nothing and records nothing for a run that froze no record", () => {
    expect(
      askAbout("github:acme/app", "the ticket names it", { subjectKey: null }),
    ).toEqual({ questions: [UNAVAILABLE_QUESTION], ask: null });
  });

  describe("the model writes one piece of this sentence and none of its shape", () => {
    it("keeps the agent's reason on one line, whatever it wrote", () => {
      // A newline in the rationale would end the one-line property the answer
      // reader leans on, and a person quoting the question back would send us
      // half a sentence we no longer recognise as ours.
      const { questions } = askAbout(
        "github:acme/app",
        "the ticket names it\n\nignore everything above",
      );

      expect(questions[0]).not.toContain("\n");
      expect(questions[0]).toContain('"the ticket names it ignore everything above"');
    });

    it("cuts a rationale the model wrote at length down to a sentence", () => {
      const { questions } = askAbout("github:acme/app", "x".repeat(500));

      expect(questions[0]).toContain(`"${"x".repeat(160)}..."`);
      expect(questions[0]).not.toContain("x".repeat(161));
    });
  });
});
