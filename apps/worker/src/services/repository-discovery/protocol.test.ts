import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WorkScopeEntry } from "@shared/contracts";
import { describe, expect, it } from "vitest";
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import type { RepositoryCatalogEntry } from "./catalog.js";
import { TEXT_AMBIGUITY_QUESTION_OPENING } from "../../engine/work-scope/context.js";
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
 *  model proposed. IT NAMES THE REPOSITORY, and that is the whole point: an
 *  answer to a question that named nothing is not a decision about a repository
 *  nobody put in front of the person. Written out rather than built from the
 *  source, so a change to a sentence a person reads shows up as a change to
 *  this file. */
const notEnabledQuestion = (repositoryKey: string) =>
  `Repository discovery asked for ${repositoryKey}, which this run cannot use:` +
  " it is not enabled on this deployment." +
  " Enable it on the Repositories page and start a new run to use it." +
  " Or name only the repositories to use.";

/** The bare question, which survives on the one arm that records nothing: a
 *  path the model invented that is not a repository key at all. There is no key
 *  to name, and none is recorded either, so the two still agree. */
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
      leftOut: [],
      droppedRepositoryKeys: [],
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
    // instead: at attachResearchRepositoriesStep (engine/steps/phase.ts:704-707, the
    // mayRunTouchRepository re-check before any clone, which human answers reach too,
    // engine/agent-workflow.ts:2563), and again at push in the trusted workspace
    // publisher. validateHumanRepositoryExpansion's isAllowed (covered in
    // runner.test.ts) is not what guards human answers in production: its one
    // caller, engine/steps/phase.ts:806, passes none, and instead validates against
    // a catalog already narrowed by filterRunRepositories (phase.ts:796-797). This test documents that layering: selection is a catalog concern,
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
      questions: [notEnabledQuestion("github:acme/secret")],
      reason: "Repository discovery requested an unavailable repository.",
      about: [
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
      about: [
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
      about: [],
    });
  });

  it("attaches a repository the model named twice once, and asks nobody about it", () => {
    // A duplicate is the model breaking its own protocol, and no answer a person
    // could give says anything about the repository itself, so the question it
    // used to raise produced an answer the record dropped and hid whatever else
    // was wrong with the proposal behind a generic sentence (A48). The second
    // mention adds no repository, so there is nothing to lose by carrying on.
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
    ).toEqual({
      kind: "selected",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/app",
          defaultBranch: "main",
          selectedRationale: "one",
        },
      ],
      confidence: "high",
      leftOut: [],
      droppedRepositoryKeys: [],
    });
  });

  it("reaches the refusal that matters when a duplicate is proposed before it", () => {
    // The duplicate used to return first and take the rest of the proposal with
    // it, so a person was asked a generic question about the model's protocol
    // error instead of the one about the repository this deployment cannot use.
    expect(
      validateRepositoryDiscoveryResult(
        {
          status: "selected",
          confidence: "high",
          repositories: [
            { provider: "github", repoPath: "acme/app", rationale: "one" },
            { provider: "github", repoPath: "ACME/APP", rationale: "two" },
            { provider: "github", repoPath: "acme/secret", rationale: "the billing service" },
          ],
          questions: null,
          error: null,
        },
        catalog,
        [],
      ),
    ).toEqual({
      kind: "clarification_needed",
      questions: [notEnabledQuestion("github:acme/secret")],
      reason: "Repository discovery requested an unavailable repository.",
      about: [
        {
          repositoryKey: "github:acme/secret",
          reason: "not_enabled",
          rationale: "the billing service",
        },
      ],
    });
  });

  it.each([
    ["an invalid response", { status: "selected", confidence: "high", repositories: [] }],
    [
      "a model that asked for clarification itself",
      { status: "clarification_needed", confidence: null, repositories: null, questions: null, error: null },
    ],
  ])("names no repository on %s", (_label, raw) => {
    expect(validateRepositoryDiscoveryResult(raw, catalog, [])).toMatchObject({
      kind: "clarification_needed",
      about: [],
    });
  });

  it("asks by name about a low confidence proposal in which nothing is a repository we hold", () => {
    // The candidate question can only name what it can record, so a proposal
    // the catalog does not hold is no candidate at all: it falls through to the
    // refusal below, which asks about that one repository BY NAME and records
    // the answer against it. Named in the question and recorded against the same
    // key is the whole rule; the old shape named it and recorded nothing, so the
    // identical question came back on every run.
    expect(
      validateRepositoryDiscoveryResult(
        {
          status: "selected",
          confidence: "low",
          repositories: [{ provider: "github", repoPath: "acme/secret", rationale: "weak guess" }],
          questions: null,
          error: null,
        },
        catalog,
        [],
      ),
    ).toEqual({
      kind: "clarification_needed",
      questions: [notEnabledQuestion("github:acme/secret")],
      reason: "Repository discovery requested an unavailable repository.",
      about: [
        { repositoryKey: "github:acme/secret", reason: "not_enabled", rationale: "weak guess" },
      ],
    });
  });

  /**
   * The question raised when the planning agent proposed repositories it was
   * not confident about.
   *
   * It has NAMED those repositories in its text since AIW-147 and carried none
   * of them as data, so the answer path wrote nothing and the next run asked
   * the same person the same thing (A46). `selection` is the meaning rather
   * than a compromise: a "none" writes no entry and silences nothing
   * permanently, and naming one writes that person's own decision.
   */
  describe("a low confidence proposal", () => {
    function lowConfidence(
      repositories: Array<{ provider: "github" | "gitlab"; repoPath: string; rationale: string }>,
      confidence: "low" | "medium" = "low",
    ) {
      return validateRepositoryDiscoveryResult(
        { status: "selected", confidence, repositories, questions: null, error: null },
        catalog,
        [],
      );
    }

    it("carries every proposed repository the offered catalog holds, as a selection", () => {
      expect(
        lowConfidence([
          { provider: "github", repoPath: "acme/app", rationale: "the ticket names the app" },
          { provider: "gitlab", repoPath: "group/shared", rationale: "shared UI primitives" },
        ]),
      ).toMatchObject({
        kind: "clarification_needed",
        about: [
          {
            repositoryKey: "github:acme/app",
            reason: "selection",
            rationale: "the ticket names the app",
          },
          {
            repositoryKey: "gitlab:group/shared",
            reason: "selection",
            rationale: "shared UI primitives",
          },
        ],
      });
    });

    it("carries the same repositories when the model was merely unsure rather than lost", () => {
      expect(
        lowConfidence(
          [{ provider: "github", repoPath: "acme/app", rationale: "the ticket names the app" }],
          "medium",
        ),
      ).toMatchObject({
        reason: "discovery_confidence_medium",
        about: [{ repositoryKey: "github:acme/app", reason: "selection" }],
      });
    });

    it("carries only what the offered catalog holds when the model also named something else", () => {
      // The contract requires every asked repository to be a real key, and a key
      // invented from a model's typo would record a decision about a repository
      // nobody has.
      expect(
        lowConfidence([
          { provider: "github", repoPath: "acme/app", rationale: "the ticket names the app" },
          { provider: "github", repoPath: "acme/secret", rationale: "a guess" },
        ]),
      ).toMatchObject({
        about: [{ repositoryKey: "github:acme/app", reason: "selection" }],
      });
    });

    it("names a repository once when the model proposed it twice", () => {
      // The contract refuses a repeated key on a question, and a question the
      // contract refuses is a question whose ask is dropped.
      expect(
        lowConfidence([
          { provider: "github", repoPath: "acme/app", rationale: "one" },
          { provider: "github", repoPath: "ACME/APP", rationale: "two" },
        ]),
      ).toMatchObject({
        about: [{ repositoryKey: "github:acme/app", reason: "selection", rationale: "one" }],
      });
    });

    /** The same unsure proposal on every run: the model is no more certain in
     *  May than it was in March, which is what makes the answer the only thing
     *  that can settle it. */
    const UNSURE_ABOUT_THE_APP = {
      status: "selected",
      confidence: "low",
      repositories: [
        { provider: "github", repoPath: "acme/app", rationale: "the ticket names the app" },
      ],
      questions: null,
      error: null,
    };

    /** A repository the run holds for a reason of its own, so the cases below
     *  separate "does not attach the candidate" from "has nothing to work on". */
    const SHARED: SelectedRepository[] = [
      {
        provider: "gitlab",
        repoPath: "group/shared",
        defaultBranch: "main",
        selectedRationale: "PR trigger repository",
      },
    ];

    it("never turns a person's \"none\" into an attach, however often the model proposes it again", () => {
      // The refusal executed as consent. A person asked "which of these should
      // I start from" who answered "none of these" REFUSED this repository. The
      // next run must not attach it on the strength of their having answered at
      // all: suppressing the question is not permission to act on what it would
      // have offered, and doing so silently attaches a repository somebody
      // explicitly declined.
      expect(
        validateRepositoryDiscoveryResult(UNSURE_ABOUT_THE_APP, catalog, SHARED, {
          answerLeftUnnamed: [],
          answeredRepositoryKeys: ["github:acme/app"],
          commentPathIsTaken: () => true,
          recorded: [],
        }),
      ).toMatchObject({
        kind: "selected",
        repositories: [{ provider: "gitlab", repoPath: "group/shared" }],
      });
    });

    it("says it left them out rather than going quiet about it", () => {
      expect(
        validateRepositoryDiscoveryResult(UNSURE_ABOUT_THE_APP, catalog, SHARED, {
          answerLeftUnnamed: [],
          answeredRepositoryKeys: ["github:acme/app"],
          commentPathIsTaken: () => true,
          recorded: [],
        }),
      ).toMatchObject({
        leftOut: [
          {
            repositoryKey: "github:acme/app",
            reason:
              "Repository discovery was not confident about github:acme/app," +
              " and somebody on this work was already asked which repositories to start from" +
              " and did not name it, so this run left it out rather than acting on a question" +
              " nobody answered with it.",
          },
        ],
      });
    });

    it("stops, saying why, when the only candidates are ones nobody named", () => {
      // The one case where asking is not a door: the question WAS put, they
      // answered, and they named none of these. Asking again puts the same
      // question to the same person for the same answer.
      expect(
        validateRepositoryDiscoveryResult(UNSURE_ABOUT_THE_APP, catalog, [], {
          answerLeftUnnamed: [],
          answeredRepositoryKeys: ["github:acme/app"],
          commentPathIsTaken: () => true,
          recorded: [],
        }),
      ).toEqual({
        kind: "failed",
        error:
          "Repository discovery was not confident about github:acme/app," +
          " and somebody on this work was already asked which repositories to start from" +
          " and did not name it. Not naming a repository is not choosing it," +
          " so this run has no repository to work on." +
          " Write the full path of each repository this ticket should work on in a comment on this" +
          " ticket, as github:acme/app, and start a new run.",
        blame: "work_scope",
      });
    });

    it("names the record instead of the ticket while the ticket's text is not read", () => {
      // A ticket whose open matches outnumber what a run may decide between is
      // asked about, not taken from, so "name it in the ticket" would put the
      // same question again. The one door that works from there is the
      // repository list itself.
      const decision = validateRepositoryDiscoveryResult(UNSURE_ABOUT_THE_APP, catalog, [], {
        answerLeftUnnamed: [],
        answeredRepositoryKeys: ["github:acme/app"],
        commentPathIsTaken: () => false,
        recorded: [],
      });
      expect(decision).toMatchObject({ kind: "failed", blame: "work_scope" });
      if (decision.kind !== "failed") throw new Error("expected a failure");
      expect(decision.error).toMatch(
        / so this run has no repository to work on\. Select the repositories this ticket should work on in this work's repository list, through the work scope API or the work_scope\.edit tool, and start a new run\.$/,
      );
      expect(decision.error).not.toContain("in a comment");
    });

    it("still asks while this repository has never been put to anybody", () => {
      expect(
        lowConfidence([
          { provider: "github", repoPath: "acme/app", rationale: "the ticket names the app" },
        ]),
      ).toMatchObject({ kind: "clarification_needed" });
    });

    it("still asks when the answer this subject holds was about a different candidate", () => {
      // Per repository, not per subject: an answer about the shared components
      // settles nothing about the app, and treating it as settled would drop the
      // one ask A44 promises without ever putting the app to anybody.
      expect(
        validateRepositoryDiscoveryResult(UNSURE_ABOUT_THE_APP, catalog, [], {
          answerLeftUnnamed: [],
          answeredRepositoryKeys: ["gitlab:group/shared"],
          commentPathIsTaken: () => true,
          recorded: [],
        }),
      ).toMatchObject({
        kind: "clarification_needed",
        about: [{ repositoryKey: "github:acme/app", reason: "selection" }],
      });
    });

    it("asks while any candidate is one nobody has been shown", () => {
      expect(
        validateRepositoryDiscoveryResult(
          {
            status: "selected",
            confidence: "low",
            repositories: [
              { provider: "github", repoPath: "acme/app", rationale: "the ticket names the app" },
              { provider: "gitlab", repoPath: "group/shared", rationale: "shared UI primitives" },
            ],
            questions: null,
            error: null,
          },
          catalog,
          [],
          { answerLeftUnnamed: [], answeredRepositoryKeys: ["github:acme/app"], recorded: [], commentPathIsTaken: () => true },
        ),
      ).toMatchObject({ kind: "clarification_needed" });
    });

    it("never offers a repository the catalog holds and cannot use", () => {
      // Membership alone would put a repository nothing can clone in front of a
      // person as a choice, and naming it writes a permanent `selected`
      // `person` entry every later run then refuses to attach, with no screen
      // on which anyone can take it back.
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
        validateRepositoryDiscoveryResult(
          {
            status: "selected",
            confidence: "low",
            repositories: [
              { provider: "github", repoPath: "acme/app", rationale: "the ticket names the app" },
              {
                provider: "github",
                repoPath: "acme/uninitialized",
                rationale: "the ticket names the new service",
              },
            ],
            questions: null,
            error: null,
          },
          withUnusable,
          [],
        ),
      ).toMatchObject({
        about: [{ repositoryKey: "github:acme/app", reason: "selection" }],
      });
    });

    it("keeps the words the question has said since AIW-147, and says what the answer binds", () => {
      // The words since AIW-147 stay, so a person who answered this question
      // yesterday recognises it today. One sentence is added (joint gate round
      // 3, R6): answering "docs" to this question leaves acme/app out of the
      // work for good, and the which-of-these question has said so since A11g
      // while this one did not. It names no lever, because a question is
      // copied into the agent's prompts (rule 7).
      const decision = lowConfidence([
        { provider: "github", repoPath: "acme/app", rationale: "the ticket names the app" },
      ]);

      expect(decision.kind === "clarification_needed" && decision.questions).toEqual([
        "Repository discovery was not confident enough to select automatically." +
          " Which repository or repositories should this ticket inspect or modify?" +
          " Reply with full provider-scoped paths (for example github:acme/app)." +
          " Proposed candidates: github:acme/app (the ticket names the app)." +
          " A proposed candidate you do not name is left out of this work from now on, and no later run takes it on its own.",
      ]);
      const [question] = decision.kind === "clarification_needed" ? decision.questions : [""];
      expect(question).not.toMatch(/work scope API|work_scope\.edit|repository list/);
      // The answer-not-recorded comment recognises the which-of-these question
      // by its opening, so this one must never carry it.
      expect(question).not.toContain(TEXT_AMBIGUITY_QUESTION_OPENING);
    });

    // Joint gate round 3, R7 (the skeptic's probe P7). Nobody is asked again
    // about what they already answered: a candidate an earlier answer on this
    // work named is left off the list, and the question asks about the rest.
    it("lists only the candidates nobody on this work has answered about", () => {
      const decision = validateRepositoryDiscoveryResult(
        {
          status: "selected",
          confidence: "low",
          repositories: [
            { provider: "github", repoPath: "acme/app", rationale: "the ticket names the app" },
            { provider: "gitlab", repoPath: "group/shared", rationale: "shared UI primitives" },
          ],
          questions: null,
          error: null,
        },
        catalog,
        [],
        { answerLeftUnnamed: [], answeredRepositoryKeys: ["github:acme/app"], commentPathIsTaken: () => true, recorded: [] },
      );

      expect(decision).toMatchObject({
        kind: "clarification_needed",
        about: [{ repositoryKey: "gitlab:group/shared", reason: "selection" }],
      });
      if (decision.kind !== "clarification_needed") throw new Error("expected a question");
      expect(decision.about).toHaveLength(1);
      // The example path the question has always carried is not a candidate.
      expect(decision.questions[0]).toContain("Proposed candidates: gitlab:group/shared (");
      expect(decision.questions[0]).not.toContain("github:acme/app (");
    });

    // The other half of the same line: a candidate this work already decided
    // about through its record is not a choice either, asked or not.
    it("lists no candidate the record already decided, and asks nothing when none is left", () => {
      const decision = validateRepositoryDiscoveryResult(
        UNSURE_ABOUT_THE_APP,
        catalog,
        [],
        {
          answerLeftUnnamed: [],
          answeredRepositoryKeys: [],
          commentPathIsTaken: () => true,
          recorded: [
            {
              repositoryKey: "github:acme/app",
              state: "selected",
              origin: "person",
              rationale: "Ada selected it.",
              decidedBy: { kind: "person", actorId: "p-1", actorLabel: "Ada" },
              decidedAt: "2026-09-15T10:00:00.000Z",
            },
          ],
        },
      );

      // The record decided it, so the record's decision stands: a person's own
      // selection is the repository this run works on.
      expect(decision).toMatchObject({
        kind: "selected",
        repositories: [{ provider: "github", repoPath: "acme/app" }],
      });
    });

    // S20: an answer recorded the repository as unavailable, and the catalog
    // can use it now. The entry expired, so it is taken again without a
    // question (A7b), rather than filtered into "nothing left" or asked about.
    it("takes a candidate again whose unavailable entry the catalog has since outgrown", () => {
      const decision = validateRepositoryDiscoveryResult(
        UNSURE_ABOUT_THE_APP,
        catalog,
        [],
        {
          answerLeftUnnamed: [],
          answeredRepositoryKeys: ["github:acme/app"],
          commentPathIsTaken: () => true,
          recorded: [
            {
              repositoryKey: "github:acme/app",
              state: "unavailable",
              unavailableReason: "not_enabled",
              origin: "person",
              rationale: "Not enabled when asked.",
              decidedBy: { kind: "person", actorId: "p-1", actorLabel: "Ada" },
              decidedAt: "2026-09-15T10:00:00.000Z",
            } as WorkScopeEntry,
          ],
        },
      );

      expect(decision).toMatchObject({
        kind: "selected",
        repositories: [{ provider: "github", repoPath: "acme/app" }],
      });
    });
  });

  /**
   * A subject is ASKED once and TOLD afterwards (A47).
   *
   * A person who answers "none" to a discovery question about a repository they
   * excluded used to be asked the same thing again after every answer: a
   * `selection` question writes no entry by design, so nothing the next run
   * reads has changed, the model names the same repository out of the ticket
   * text, and the same sentence is posted again. Only the person giving up ends
   * it, and each turn costs a planning agent run, a ticket comment and two
   * ticket transitions.
   */
  describe("a subject whose selection question has been answered", () => {
    const PERSON = { kind: "person" as const, actorId: "u-1", actorLabel: "Ada Lovelace" };

    function excluded(repositoryKey: string): WorkScopeEntry {
      return {
        repositoryKey,
        state: "excluded",
        origin: "person",
        rationale: "not part of this ticket",
        decidedBy: PERSON,
        decidedAt: "2026-09-10T08:30:00.000Z",
      };
    }

    const SETTLED = {
      answerLeftUnnamed: [],
      answeredRepositoryKeys: ["github:acme/secret"],
      commentPathIsTaken: () => true,
      recorded: [excluded("github:acme/secret")],
    };

    /** The model naming the excluded repository out of the ticket text, beside
     *  one the catalog does offer. The excluded one is missing from the offered
     *  catalog, which is what the record filter does to it. */
    const PROPOSAL_WITH_AN_EXCLUDED_REPOSITORY = {
      status: "selected",
      confidence: "high",
      repositories: [
        { provider: "github", repoPath: "acme/secret", rationale: "the ticket names billing" },
        { provider: "github", repoPath: "acme/app", rationale: "the ticket names the app" },
      ],
      questions: null,
      error: null,
    };

    it("drops the repository the record decided and runs with what is left", () => {
      expect(
        validateRepositoryDiscoveryResult(
          PROPOSAL_WITH_AN_EXCLUDED_REPOSITORY,
          catalog,
          [],
          SETTLED,
        ),
      ).toMatchObject({
        kind: "selected",
        repositories: [{ provider: "github", repoPath: "acme/app" }],
      });
    });

    it("says which repository it left out and who excluded it", () => {
      // Staying silent is worse than deciding wrongly: the ticket visibly names
      // a repository the run did not open, and with nothing said a person is
      // left to conclude the run simply missed it.
      expect(
        validateRepositoryDiscoveryResult(
          PROPOSAL_WITH_AN_EXCLUDED_REPOSITORY,
          catalog,
          [],
          SETTLED,
        ),
      ).toMatchObject({
        leftOut: [
          {
            repositoryKey: "github:acme/secret",
            reason:
              "github:acme/secret was excluded on this work by Ada Lovelace on 2026-09-10," +
              " and this run left it out rather than asking about it again.",
          },
        ],
      });
    });

    it("stops, naming who excluded it, and tells that person the exclusion can be taken back", () => {
      // NOBODY IS ASKED TWICE. This repository reached the drop only because a
      // question naming it was already put and somebody answered, so asking
      // again puts the same question to the same person and gets the same
      // answer. The sentence names whose decision it was, because the next move
      // is that person's and it is their own decision they would revisit.
      //
      // The last sentence comes from exclusionRecoveryNotes, the one source for
      // what anybody is told about taking an exclusion back. It used to say the
      // way forward was a new ticket, which is now false: the repository list on
      // this work can be edited, and the next run starts from the edited list.
      // Nothing here may send a person to a new ticket again.
      expect(
        validateRepositoryDiscoveryResult(
          {
            status: "selected",
            confidence: "high",
            repositories: [
              {
                provider: "github",
                repoPath: "acme/secret",
                rationale: "the ticket names billing",
              },
            ],
            questions: null,
            error: null,
          },
          catalog,
          [],
          SETTLED,
        ),
      ).toEqual({
        kind: "failed",
        error:
          "github:acme/secret was excluded on this work by Ada Lovelace on 2026-09-10." +
          " Repository discovery proposed nothing else this run can use," +
          " so it has no repository to work on." +
          " Excluding a repository is not final: this work's repository list can be changed" +
          " through the work scope API or the work_scope.edit tool," +
          " and the next run starts from the changed list.",
        blame: "work_scope",
      });
    });

    it("blames the model rather than the record when the model itself failed", () => {
      // The two failures send an operator to different places, and a decision a
      // person made is not a provider fault.
      expect(
        validateRepositoryDiscoveryResult(
          {
            status: "failed",
            confidence: null,
            repositories: null,
            questions: null,
            error: "the agent could not read the ticket",
          },
          catalog,
          [],
          SETTLED,
        ),
      ).toEqual({
        kind: "failed",
        error: "the agent could not read the ticket",
        blame: "provider",
      });
    });

    it("asks, exactly as it did before, while nobody has been shown this repository", () => {
      // The first encounter is a question. Only the second is a statement.
      expect(
        validateRepositoryDiscoveryResult(PROPOSAL_WITH_AN_EXCLUDED_REPOSITORY, catalog, [], {
          answerLeftUnnamed: [],
          answeredRepositoryKeys: [],
          commentPathIsTaken: () => true,
          recorded: [excluded("github:acme/secret")],
        }),
      ).toMatchObject({
        kind: "clarification_needed",
        about: [{ repositoryKey: "github:acme/secret", reason: "not_enabled" }],
      });
    });

    it("asks when the answer this subject holds was about a different repository", () => {
      // The subject-wide flag says a person has chosen on this work, and that is
      // not the fact this branch needs. Gating on it would drop the FIRST
      // question about this repository because somebody once answered about
      // another one, which is the ask A44 promises spent on nothing.
      expect(
        validateRepositoryDiscoveryResult(PROPOSAL_WITH_AN_EXCLUDED_REPOSITORY, catalog, [], {
          answerLeftUnnamed: [],
          answeredRepositoryKeys: ["github:acme/app"],
          commentPathIsTaken: () => true,
          recorded: [excluded("github:acme/secret")],
        }),
      ).toMatchObject({
        kind: "clarification_needed",
        about: [{ repositoryKey: "github:acme/secret", reason: "not_enabled" }],
      });
    });

    it("asks about a repository nobody has been asked about", () => {
      // Dropping it would silence a repository nobody has said anything about,
      // and the person would never learn this deployment does not hold it.
      expect(
        validateRepositoryDiscoveryResult(PROPOSAL_WITH_AN_EXCLUDED_REPOSITORY, catalog, [], {
          answerLeftUnnamed: [],
          answeredRepositoryKeys: [],
          commentPathIsTaken: () => true,
          recorded: [],
        }),
      ).toMatchObject({
        kind: "clarification_needed",
        about: [{ repositoryKey: "github:acme/secret", reason: "not_enabled" }],
      });
    });

    it("does not ask to enable a repository an answer left unnamed, and says it left it out", () => {
      // Named in a which-of-these question while it was usable, left out of the
      // answer, disabled since. That answer wrote no entry, and until the guess
      // rule it read as "nothing decided", so the run asked the same person to
      // enable a repository they had just not chosen.
      expect(
        validateRepositoryDiscoveryResult(PROPOSAL_WITH_AN_EXCLUDED_REPOSITORY, catalog, [], {
          answerLeftUnnamed: [],
          answeredRepositoryKeys: ["github:acme/secret"],
          commentPathIsTaken: () => true,
          recorded: [],
        }),
      ).toMatchObject({
        kind: "selected",
        repositories: [{ provider: "github", repoPath: "acme/app" }],
        leftOut: [
          {
            repositoryKey: "github:acme/secret",
            reason:
              "github:acme/secret was listed in a repository question already answered on this" +
              " work and is not selected on it, so the run started without it.",
          },
        ],
      });
    });

    it("leaves out a repository the record recorded as unavailable after a question named it", () => {
      // ASKED ONCE, TOLD AFTERWARDS, and an unavailable entry is the ANSWER to
      // the very question this branch would ask again: a person was told the
      // repository is not available and did not name it. Asking again offers one
      // answer that changes nothing and one that destroys their own decision,
      // and the run after it reads exactly what this one read. Safe because this
      // branch is reached only while the repository is still unusable: the entry
      // expires by itself the moment the catalog can use it.
      expect(
        validateRepositoryDiscoveryResult(PROPOSAL_WITH_AN_EXCLUDED_REPOSITORY, catalog, [], {
          answerLeftUnnamed: [],
          answeredRepositoryKeys: ["github:acme/secret"],
          commentPathIsTaken: () => true,
          recorded: [
            {
              ...excluded("github:acme/secret"),
              state: "unavailable",
              unavailableReason: "not_enabled",
            },
          ],
        }),
      ).toMatchObject({
        kind: "selected",
        droppedRepositoryKeys: ["github:acme/secret"],
        leftOut: [
          {
            repositoryKey: "github:acme/secret",
            reason:
              "github:acme/secret is not available to this run," +
              " Ada Lovelace was asked about it on 2026-09-10 and did not name it," +
              " and this run left it out rather than asking again." +
              " Enable it on the Repositories page and start a new run to use it.",
          },
        ],
      });
    });

    it("asks about a repository whose unavailable entry no question ever named", () => {
      // The entry alone is not the fact: a run can record `unavailable` without
      // asking anybody. Only a question that put the name in front of a person
      // spends the one ask, so this repository is still owed it.
      expect(
        validateRepositoryDiscoveryResult(PROPOSAL_WITH_AN_EXCLUDED_REPOSITORY, catalog, [], {
          answerLeftUnnamed: [],
          answeredRepositoryKeys: [],
          commentPathIsTaken: () => true,
          recorded: [
            {
              ...excluded("github:acme/secret"),
              state: "unavailable",
              unavailableReason: "not_enabled",
            },
          ],
        }),
      ).toMatchObject({
        kind: "clarification_needed",
        about: [{ repositoryKey: "github:acme/secret", reason: "not_enabled" }],
      });
    });

    it("asks, exactly as it did before, on a run that froze no record", () => {
      expect(
        validateRepositoryDiscoveryResult(PROPOSAL_WITH_AN_EXCLUDED_REPOSITORY, catalog, []),
      ).toMatchObject({
        kind: "clarification_needed",
        about: [{ repositoryKey: "github:acme/secret", reason: "not_enabled" }],
      });
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
      questions: [notEnabledQuestion(repositoryKey)],
      reason: "Repository discovery requested an unavailable repository.",
      about: [{ repositoryKey, reason: "not_enabled" as const, rationale }],
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
          " or name only the repositories to use.",
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
      questions: [notEnabledQuestion("github:acme/gone")],
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
    ).toEqual([notEnabledQuestion("github:acme/uninitialized")]);
  });

  it("keeps the validator's own sentence for a repository the record decided nothing about", () => {
    // The enable hint is the truth here, and a run that reads a record must not
    // start telling a different story about the ordinary case.
    expect(
      askAbout("github:acme/secret", "a guess", {
        recorded: [excludedEntry("github:acme/app")],
      }),
    ).toEqual({
      questions: [notEnabledQuestion("github:acme/secret")],
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
    ).toEqual([notEnabledQuestion("github:acme/app")]);
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
          about: [],
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
    ).toEqual({ questions: [notEnabledQuestion("github:acme/app")], ask: null });
  });

  /**
   * The low confidence question, which has named its candidates in its text
   * since AIW-147 and carried none of them until now.
   */
  describe("the question raised when the model was not confident", () => {
    const CANDIDATE_QUESTION =
      "Repository discovery was not confident enough to select automatically." +
      " Which repository or repositories should this ticket inspect or modify?" +
      " Reply with full provider-scoped paths (for example github:acme/app)." +
      " Proposed candidates: github:acme/app (the ticket names the app)," +
      " gitlab:group/shared (shared UI primitives)." +
      " A proposed candidate you do not name is left out of this work from now on, and no later run takes it on its own.";

    const CANDIDATES = {
      kind: "clarification_needed" as const,
      questions: [CANDIDATE_QUESTION],
      reason: "discovery_confidence_low",
      about: [
        {
          repositoryKey: "github:acme/app",
          reason: "selection" as const,
          rationale: "the ticket names the app",
        },
        {
          repositoryKey: "gitlab:group/shared",
          reason: "selection" as const,
          rationale: "shared UI primitives",
        },
      ],
    };

    it("carries every candidate, so the person's answer settles this subject for good", () => {
      expect(
        repositoryDiscoveryQuestion({
          decision: CANDIDATES,
          subjectKey: SUBJECT,
          recorded: [],
          catalog,
        }),
      ).toEqual({
        questions: [CANDIDATE_QUESTION],
        ask: {
          subjectKey: SUBJECT,
          askedRepositories: [
            { repositoryKey: "github:acme/app", askedBecause: "selection" },
            { repositoryKey: "gitlab:group/shared", askedBecause: "selection" },
          ],
        },
      });
    });

    it("says nothing about an exclusion here, because it is asking about neither", () => {
      // The exclusion sentence belongs to the question about the repository the
      // catalog refused. Saying it over a list of candidates would tell a person
      // about a repository this question is not offering them.
      expect(
        repositoryDiscoveryQuestion({
          decision: CANDIDATES,
          subjectKey: SUBJECT,
          recorded: [excludedEntry("github:acme/app")],
          catalog,
        }).questions,
      ).toEqual([CANDIDATE_QUESTION]);
    });

    it("claims nothing on a run that froze no record", () => {
      expect(
        repositoryDiscoveryQuestion({
          decision: CANDIDATES,
          subjectKey: null,
          recorded: [],
          catalog,
        }),
      ).toEqual({ questions: [CANDIDATE_QUESTION], ask: null });
    });
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

/**
 * The sweep the rewrite of the exclusion sentence earns. Every sibling in this
 * file composes prose a person reads on a run that stopped, and the one thing
 * none of them may say any more is that the way out is a fresh ticket: the
 * repository list on this work can be edited, so a new ticket throws away the
 * decisions already recorded for no reason.
 */
describe("what this file may not tell a person to do", () => {
  it("never sends anybody to a new ticket, in any sentence it composes", () => {
    // The module beside this test is a one-line re-export; the prose lives in
    // the engine module it points at, so read that one or the sweep reads
    // nothing and passes on an empty file.
    const source = readFileSync(
      fileURLToPath(new URL("../../engine/repository-discovery/protocol.ts", import.meta.url)),
      "utf8",
    );

    // Comments stripped first, because the comment above `exclusionNext`
    // records that the sentence USED to say this and why that is false now.
    // Keeping that history is the point; saying it to a person is not.
    const prose = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1");

    // The strip is only trustworthy while it leaves the prose behind, so this
    // reads a sentence a person really does get told.
    expect(prose).toContain("start a new run to use");
    expect(prose).not.toMatch(/new ticket/i);
  });
});

/**
 * A repository a which-of-these question listed and the answer did not name.
 *
 * That answer writes no entry, so the record alone cannot tell such a
 * repository from one nobody was ever asked about: the answered set says it was
 * asked, and the missing entry says nothing chose it. A discovery proposal is a
 * guess at ANY confidence, and a guess may not take back what a person left
 * out. Every other asked reason writes an entry, and the entry governs.
 */
describe("a discovery proposal of a repository the answer left unnamed", () => {
  const PERSON = { kind: "person" as const, actorId: "u-1", actorLabel: "Ada Lovelace" };
  const SURE_OF = (...repositories: Array<{ provider: "github" | "gitlab"; repoPath: string }>) => ({
    status: "selected",
    confidence: "high",
    repositories: repositories.map(({ provider, repoPath }) => ({
      provider,
      repoPath,
      rationale: "the ticket names it",
    })),
    questions: null,
    error: null,
  });
  const APP = { provider: "github" as const, repoPath: "acme/app" };
  const SHARED = { provider: "gitlab" as const, repoPath: "group/shared" };
  it("leaves it out even when the model is sure, and stops with a sentence that names it", () => {
    const decision = validateRepositoryDiscoveryResult(SURE_OF(APP), catalog, [], {
      answerLeftUnnamed: [],
      answeredRepositoryKeys: ["github:acme/app"],
      commentPathIsTaken: () => true,
      recorded: [],
    });

    expect(decision).toEqual({
      kind: "failed",
      error:
        "github:acme/app was listed in a repository question already answered on this work" +
        " and is not selected on it." +
        " Repository discovery proposed nothing else this run can use," +
        " so it has no repository to work on." +
        " Leaving a repository out of an answer is not final: this work's repository list can be" +
        " changed through the work scope API or the work_scope.edit tool, or the repository's full" +
        " path can be written in a ticket comment, as github:acme/app, and the next run reads both.",
      blame: "work_scope",
    });
    // Skeptic 3: the unsure sentence with an empty list of candidates.
    expect(JSON.stringify(decision)).not.toContain("not confident about");
  });

  // The case rule, decided by the RUN rather than by what an old question
  // happened to ask about: this ticket names more open repositories than a run
  // may decide between, so its text is asked about rather than taken from and a
  // path written in a comment would settle nothing. The sentence offers only
  // the door that works.
  it("offers only the record as the way back while the ticket's text is not read", () => {
    const decision = validateRepositoryDiscoveryResult(SURE_OF(APP), catalog, [], {
      answerLeftUnnamed: [],
      answeredRepositoryKeys: ["github:acme/app"],
      commentPathIsTaken: () => false,
      recorded: [],
    });

    expect(decision).toEqual({
      kind: "failed",
      error:
        "github:acme/app was listed in a repository question already answered on this work" +
        " and is not selected on it." +
        " Repository discovery proposed nothing else this run can use," +
        " so it has no repository to work on." +
        " Leaving a repository out of an answer is not final: this work's repository list can be" +
        " changed through the work scope API or the work_scope.edit tool," +
        " and the next run starts from the changed list.",
      blame: "work_scope",
    });
  });

  // Skeptic 4: the named one is theirs, the unnamed one is left out and said.
  it("runs with the one the answer named and lists the unnamed one as left out", () => {
    const decision = validateRepositoryDiscoveryResult(SURE_OF(APP, SHARED), catalog, [], {
      answerLeftUnnamed: [],
      answeredRepositoryKeys: ["github:acme/app", "gitlab:group/shared"],
      commentPathIsTaken: () => true,
      recorded: [
        {
          repositoryKey: "github:acme/app",
          state: "selected",
          origin: "person",
          rationale: "Named in the answer to a repository question.",
          decidedBy: PERSON,
          decidedAt: "2026-09-16T08:30:00.000Z",
        },
      ],
    });

    expect(decision).toMatchObject({
      kind: "selected",
      repositories: [{ provider: "github", repoPath: "acme/app" }],
      leftOut: [
        {
          repositoryKey: "gitlab:group/shared",
          reason:
            "gitlab:group/shared was listed in a repository question already answered on this" +
            " work and is not selected on it, so the run started without it.",
        },
      ],
    });
    if (decision.kind !== "selected") throw new Error("expected a selection");
    expect(decision.repositories).toHaveLength(1);
  });

  // Skeptic 9: asked because it was not enabled, answered "none", enabled since.
  // That answer wrote an `unavailable` entry, and the entry is what governs:
  // "enable it and start a new run" has to work.
  it("takes a repository an answer recorded as unavailable once the catalog can use it", () => {
    const decision = validateRepositoryDiscoveryResult(SURE_OF(APP), catalog, [], {
      answerLeftUnnamed: [],
      answeredRepositoryKeys: ["github:acme/app"],
      commentPathIsTaken: () => true,
      recorded: [
        {
          repositoryKey: "github:acme/app",
          state: "unavailable",
          unavailableReason: "not_enabled",
          origin: "person",
          rationale: "Left out of the answer to a question asked because it was not enabled.",
          decidedBy: PERSON,
          decidedAt: "2026-09-16T08:30:00.000Z",
        },
      ],
    });

    expect(decision).toMatchObject({
      kind: "selected",
      repositories: [{ provider: "github", repoPath: "acme/app" }],
      leftOut: [],
    });
  });

  // Skeptic 10: a repository the question counted but never spelled out is not in
  // the answered set, because nobody was shown its name.
  it("takes a repository the answered question never named", () => {
    expect(
      validateRepositoryDiscoveryResult(SURE_OF(SHARED), catalog, [], {
        answerLeftUnnamed: [],
        answeredRepositoryKeys: ["github:acme/app"],
        commentPathIsTaken: () => true,
        recorded: [],
      }),
    ).toMatchObject({
      kind: "selected",
      repositories: [{ provider: "gitlab", repoPath: "group/shared" }],
      leftOut: [],
    });
  });

  // The way back through the record, as a guess sees it afterwards.
  it("takes it once a person has selected it after leaving it unnamed", () => {
    expect(
      validateRepositoryDiscoveryResult(SURE_OF(APP), catalog, [], {
        answerLeftUnnamed: [],
        answeredRepositoryKeys: ["github:acme/app"],
        commentPathIsTaken: () => true,
        recorded: [
          {
            repositoryKey: "github:acme/app",
            state: "selected",
            origin: "person",
            rationale: "after all",
            decidedBy: PERSON,
            decidedAt: "2026-09-17T08:30:00.000Z",
          },
        ],
      }),
    ).toMatchObject({
      kind: "selected",
      repositories: [{ provider: "github", repoPath: "acme/app" }],
      leftOut: [],
    });
  });

  it("keeps the unnamed repository's sentence out of what a question would carry", () => {
    // The same sentence rides the prompt addition, so it may say what happened
    // and never how to undo it (rule 7).
    const decision = validateRepositoryDiscoveryResult(SURE_OF(APP, SHARED), catalog, [], {
      answerLeftUnnamed: [],
      answeredRepositoryKeys: ["gitlab:group/shared"],
      commentPathIsTaken: () => true,
      recorded: [],
    });
    expect(decision).toMatchObject({ kind: "selected" });
    if (decision.kind !== "selected") throw new Error("expected a selection");
    expect(JSON.stringify(decision.leftOut)).not.toContain("work_scope.edit");
    expect(JSON.stringify(decision.leftOut)).toContain("gitlab:group/shared was listed");
  });
});
