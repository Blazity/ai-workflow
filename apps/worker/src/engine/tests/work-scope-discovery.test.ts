import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The in-run repository DISCOVERY question, seen from the record.
 *
 * Discovery runs the agent once and its proposal is final, so unlike the
 * expansion there is no turn in which the model can be refused and try again:
 * every disagreement here reaches a person or nobody. What that person is told
 * has to be true, and what they answer has to settle the question for good,
 * which it only does when the question names the repository it is about.
 *
 * The discovery closure in `agent-workflow.ts` cannot be invoked by a test, so
 * these drive the exported seams it is built from in the order it uses them,
 * the way `work-scope-expansion.test.ts` drives the expansion: the record
 * filters the catalog, the validator decides against that filtered list,
 * `repositoryDiscoveryQuestion` decides what the person reads and what the
 * question names, and the one door puts it on the run context.
 */
import type {
  TriggerRepositoryPolicy,
  WorkScope,
  WorkScopeAskedRepository,
  WorkScopeEntry,
  WorkScopeQuestionAnswer,
} from "@shared/contracts";
import { createRepositoryQuestions } from "../agent-workflow.js";
import { makeCtx } from "../blocks/support/test-support.js";
import type { RepositoryCatalogEntry } from "../repository-discovery/catalog.js";
import {
  repositoryDiscoveryQuestion,
  validateRepositoryDiscoveryResult,
} from "../repository-discovery/protocol.js";
import {
  offerableRepositoryCatalog,
  validateHumanRepositoryExpansion,
} from "../repository-discovery/runner.js";
// The real comment builder, so a test can send the question back in the form a
// person was actually shown rather than the form we stored.
import { formatClarificationQuestionsComment } from "../support/clarification-comment-format.js";
import { readRepositoryAnswer } from "../work-scope/answer.js";
import {
  commentPathAfterAnUnrecordedAnswer,
  consumeWorkScopeAsk,
  createRunWorkScopeRecorder,
  type TicketTextReading,
} from "../work-scope/context.js";
import { decideWorkScope } from "../work-scope/decide.js";

const SUBJECT = "ticket:jira:AWT-1";
const NOW = "2026-09-15T12:00:00.000Z";
const ANSWERED_AT = "2026-09-16T09:00:00.000Z";

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
  expansion: "attach",
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

const CATALOG = [catalogEntry("github", "acme/web"), catalogEntry("github", "acme/api")];

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

function proposal(repoPath: string, rationale: string, provider: "github" | "gitlab" = "github") {
  return {
    status: "selected",
    confidence: "high",
    repositories: [{ provider, repoPath, rationale }],
    questions: null,
    error: null,
  };
}

/** The model proposing repositories it is not confident enough about to be
 *  believed, which is the last discovery question that used to settle nothing. */
function unsureProposal(...repositories: Array<[repoPath: string, rationale: string]>) {
  return {
    status: "selected",
    confidence: "low",
    repositories: repositories.map(([repoPath, rationale]) => ({
      provider: "github" as const,
      repoPath,
      rationale,
    })),
    questions: null,
    error: null,
  };
}

/**
 * One pass of the discovery closure: the record filters the catalog, the
 * validator decides against that filtered list, and the question goes through
 * the one door that puts what it asks about on the run context.
 *
 * `scope` undefined is a run that froze no record, which is every run before
 * this feature shipped.
 */
interface DiscoveryInput {
  raw: unknown;
  scope?: WorkScope | null;
  selectionAnswered?: boolean;
  /** The repositories a question on this subject already put to somebody who
   *  answered. Undefined leaves the field off the run context entirely, which
   *  is a run resuming from a context frozen before the fact existed. */
  answeredRepositoryKeys?: string[];
  /** What the run holds for a reason of its own, as a pull request trigger
   *  does. It separates "did not attach the candidate" from "was left with
   *  nothing", which are two different outcomes with two different sentences. */
  mandatory?: Array<{
    provider: "github" | "gitlab";
    repoPath: string;
    defaultBranch: string;
    selectedRationale: string;
  }>;
  catalog?: RepositoryCatalogEntry[];
  door?: ReturnType<typeof createRepositoryQuestions>;
  ctx?: ReturnType<typeof makeCtx>;
  /** The pre-sandbox's reading of the ticket, which decides whether a path
   *  written in a comment reaches the next run and is taken. */
  ticketText?: TicketTextReading | null;
}

/** The record filtering the catalog and the validator deciding against that
 *  filtered list, which is everything the closure does before it knows whether
 *  a person will be asked anything at all. */
function decide(input: DiscoveryInput) {
  const catalog = input.catalog ?? CATALOG;
  const selectionAnswered = input.selectionAnswered ?? false;
  const ctx =
    input.ctx ??
    makeCtx(
      input.scope === undefined
        ? {}
        : {
            workScope: {
              subjectKey: SUBJECT,
              scope: input.scope,
              selectionAnswered,
              ...(input.answeredRepositoryKeys === undefined
                ? {}
                : { answeredRepositoryKeys: input.answeredRepositoryKeys }),
            },
          },
    );
  const record =
    input.scope === undefined
      ? null
      : createRunWorkScopeRecorder({
          subjectKey: SUBJECT,
          scope: input.scope,
          selectionAnswered,
          answeredRepositoryKeys: input.answeredRepositoryKeys ?? [],
          // The pre-sandbox's reading, carried into the run the way
          // `agent-workflow.ts` carries it. A ticket naming nothing, on a run
          // that can date comments against every answer, is the ordinary shape
          // here: a comment naming one repository would be read by the next run.
          // A discovery proposal is a guess whatever the ticket says, so nothing
          // written after the answer unbinds anything on this path.
          ticketText: input.ticketText ?? {
            matchedKeys: [],
            datableKeys: input.answeredRepositoryKeys ?? [],
            mentionedAfterAnswerKeys: [],
          },
          catalog: {
            activated: true,
            enabledKeys: catalog.map((repo) => `${repo.provider}:${repo.repoPath}`),
            unusableKeys: catalog
              .filter((repo) => !repo.usable)
              .map((repo) => `${repo.provider}:${repo.repoPath}`),
          },
          policy: ANY_CATALOG,
          actor: RUN_ACTOR,
          now: NOW,
          attachedKeys: [],
        });
  const offered = offerableRepositoryCatalog(catalog, record);
  const decision = validateRepositoryDiscoveryResult(
    input.raw,
    offered,
    input.mandatory ?? [],
    record
      ? {
          // Off the context, and empty when the context carries none, exactly
          // as the closure in `agent-workflow.ts` reads it.
          answeredRepositoryKeys: ctx.workScope?.answeredRepositoryKeys ?? [],
          recorded: input.scope?.entries ?? [],
          commentPathIsTaken: (repositoryKeys) => record.commentPathIsTaken(repositoryKeys),
        }
      : undefined,
  );
  return { ctx, record, catalog, decision };
}

function discover(input: DiscoveryInput) {
  const { ctx, record, catalog, decision } = decide(input);
  if (decision.kind !== "clarification_needed") {
    throw new Error(`discovery decided ${decision.kind}, not a question`);
  }
  const { questions, ask } = repositoryDiscoveryQuestion({
    decision,
    subjectKey: record?.subjectKey ?? null,
    recorded: ctx.workScope?.scope?.entries ?? [],
    catalog,
  });
  const door = input.door ?? createRepositoryQuestions(ctx);
  const raised = door.raise(questions, ask);
  return { ctx, decision, raised, door, ask: consumeWorkScopeAsk(ctx) };
}

describe("a discovery question about a repository somebody excluded tells the truth", () => {
  it("names the person, the date and what answering with the repository will do", () => {
    const { raised } = discover({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      raw: proposal("acme/api", "the ticket names the API schema"),
    });

    expect(raised.questions).toEqual([
      "github:acme/api was excluded on this work by Ada Lovelace on 2026-09-10." +
        ' Repository discovery asked for it anyway, because "the ticket names the API schema".' +
        " Answer with github:acme/api to take that exclusion back and let this run use it," +
        " or name only the repositories to use.",
    ]);
  });

  // The reviewer's note on R12: the predicate that decides what a person is
  // told about writing a path in a comment knows a question by its words, so it
  // is fed the words this builder actually produces. A test carrying its own
  // copy of the sentence cannot drift; the builder can, and the drift is
  // silent, because both branches of the predicate return a sentence.
  it("is recognised by the comment-path predicate as a question it cannot prove a route for", () => {
    const { raised } = discover({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      raw: proposal("acme/api", "the ticket names the API schema"),
    });

    expect(commentPathAfterAnUnrecordedAnswer({ questions: raised.questions })).toBe("unproven");
  });

  it("never tells the person to enable a repository this deployment already enables", () => {
    // The repository is enabled and usable; the only thing between the run and
    // it is their own decision. The enable hint sends them to a page where
    // there is nothing to do.
    const { raised } = discover({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      raw: proposal("acme/api", "the ticket names the API schema"),
    });

    expect(raised.questions.join(" ")).not.toContain("Enable it on the Repositories page");
  });

  it("carries the repository on the question, under the reason that leaves a `none` alone", () => {
    // `selection` is the correct meaning rather than a compromise: "none" must
    // leave the earlier exclusion standing and write nothing, and naming the
    // repository must write the new decision.
    const { ask } = discover({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      raw: proposal("acme/api", "the ticket names the API schema"),
    });

    expect(ask).toEqual({
      subjectKey: SUBJECT,
      askedRepositories: [{ repositoryKey: "github:acme/api", askedBecause: "selection" }],
    });
  });

  it("asks about it at all, which only happens because the catalog filter kept it out", () => {
    // The record removes an excluded repository from the list the model is
    // offered, so the validator cannot resolve it and refuses. That half of the
    // feature is what turns a silent attach into this question.
    const record = createRunWorkScopeRecorder({
      subjectKey: SUBJECT,
      scope: scopeOf(entry("github:acme/api", "excluded")),
      selectionAnswered: false,
      answeredRepositoryKeys: [],
      ticketText: { matchedKeys: [], datableKeys: [], mentionedAfterAnswerKeys: [] },
      catalog: {
        activated: true,
        enabledKeys: CATALOG.map((repo) => `${repo.provider}:${repo.repoPath}`),
        unusableKeys: [],
      },
      policy: ANY_CATALOG,
      actor: RUN_ACTOR,
      now: NOW,
    });

    expect(
      offerableRepositoryCatalog(CATALOG, record).map((repo) => repo.repoPath),
    ).toEqual(["acme/web"]);
  });
});

describe("a discovery question about a repository nobody decided names it", () => {
  it("names the repository the catalog does not hold, and carries it as not_enabled", () => {
    const { raised, ask } = discover({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      raw: proposal("acme/secret", "the ticket names the billing service"),
    });

    // NAMED AND RECORDED ARE ONE LIST. The question used to say only "which
    // repository should this ticket use" while the ask beside it carried this
    // key, so a person answering it was recorded as having decided about a
    // repository they were never shown.
    expect(raised.questions).toEqual([
      "Repository discovery asked for github:acme/secret, which this run cannot use:" +
        " it is not enabled on this deployment." +
        " Enable it on the Repositories page and start a new run to use it." +
        " Or name only the repositories to use.",
    ]);
    expect(ask?.askedRepositories).toEqual([
      { repositoryKey: "github:acme/secret", askedBecause: "not_enabled" },
    ]);
  });

  it("carries a repository the catalog holds and cannot use as unusable", () => {
    const catalog = [...CATALOG, catalogEntry("github", "acme/fresh", false)];

    const { ask, raised } = discover({
      scope: scopeOf(),
      catalog,
      raw: proposal("acme/fresh", "the ticket names the new service"),
    });

    expect(ask?.askedRepositories).toEqual([
      { repositoryKey: "github:acme/fresh", askedBecause: "unusable" },
    ]);
    // Round 5, S6. This arm offers the person no move of their own, so the
    // sentence after it is not an alternative to one: an "Or" here was an "or"
    // to nothing, which reads as a missing sentence.
    expect(raised.questions.join(" ")).not.toContain("Or name only");
    expect(raised.questions.join(" ")).toContain(
      "cannot clone it, so no run can use it until that changes. Name only the repositories to use.",
    );
  });
});

describe("a run that froze no record behaves exactly as it did before", () => {
  it("asks the same sentence and leaves nothing on the run context", () => {
    const withoutRecord = discover({ raw: proposal("acme/secret", "a guess") });
    const withRecord = discover({
      scope: scopeOf(),
      raw: proposal("acme/secret", "a guess"),
    });

    expect(withoutRecord.raised.questions).toEqual([
      "Repository discovery asked for github:acme/secret, which this run cannot use:" +
        " it is not enabled on this deployment." +
        " Enable it on the Repositories page and start a new run to use it." +
        " Or name only the repositories to use.",
    ]);
    // The sentence a person reads did not change; only what the question
    // carries alongside it did, and without a record there is nothing to carry
    // it against.
    expect(withoutRecord.raised.questions).toEqual(withRecord.raised.questions);
    expect(withoutRecord.ask).toBeUndefined();
  });
});

describe("every discovery question carries its own repositories", () => {
  it("gives a second question in the same run its own, never the first one's", () => {
    // The park chain TAKES the field as it reads it, so the ask is set
    // immediately before each question rather than once at the top of the run.
    const ctx = makeCtx({
      workScope: {
        subjectKey: SUBJECT,
        scope: scopeOf(entry("github:acme/api", "excluded")),
        selectionAnswered: false,
      },
    });
    const door = createRepositoryQuestions(ctx);

    const first = discover({
      ctx,
      door,
      scope: scopeOf(entry("github:acme/api", "excluded")),
      raw: proposal("acme/api", "the ticket names the API schema"),
    });
    const second = discover({
      ctx,
      door,
      scope: scopeOf(entry("github:acme/api", "excluded")),
      raw: proposal("acme/secret", "the ticket names the billing service"),
    });

    expect(first.ask?.askedRepositories).toEqual([
      { repositoryKey: "github:acme/api", askedBecause: "selection" },
    ]);
    expect(second.ask?.askedRepositories).toEqual([
      { repositoryKey: "github:acme/secret", askedBecause: "not_enabled" },
    ]);
  });

  it("asks nobody about a repository the model proposed twice, and takes it once", () => {
    // A model that proposed the same repository twice broke its own protocol,
    // and there is no answer a person could give that says anything about the
    // repository itself. The question it used to raise named no repository, so
    // the answer was dropped anyway (A48).
    const { decision, ctx } = decide({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      raw: {
        status: "selected",
        confidence: "high",
        repositories: [
          { provider: "github", repoPath: "acme/web", rationale: "one" },
          { provider: "github", repoPath: "ACME/WEB", rationale: "two" },
        ],
        questions: null,
        error: null,
      },
    });

    expect(decision).toMatchObject({
      kind: "selected",
      repositories: [{ provider: "github", repoPath: "acme/web" }],
    });
    expect(consumeWorkScopeAsk(ctx)).toBeUndefined();
  });
});

/**
 * The LOW CONFIDENCE question: the planning agent proposed repositories but was
 * not sure enough of them to be believed, so a person is asked to confirm.
 *
 * It has named those repositories in its text since AIW-147 and carried none of
 * them, so the answer path wrote nothing and the next run asked the same person
 * the same thing. It is the same defect as the one the excluded question above
 * closed, on the same path, and it was the last one on it.
 */
describe("a discovery question about repositories the model was unsure of", () => {
  it("carries every candidate the catalog holds, under the reason that leaves a `none` alone", () => {
    const { ask } = discover({
      scope: scopeOf(),
      raw: unsureProposal(
        ["acme/web", "the ticket names the dashboard"],
        ["acme/api", "the ticket names the API schema"],
      ),
    });

    expect(ask).toEqual({
      subjectKey: SUBJECT,
      askedRepositories: [
        { repositoryKey: "github:acme/web", askedBecause: "selection" },
        { repositoryKey: "github:acme/api", askedBecause: "selection" },
      ],
    });
  });

  it("names only the candidate it can record, when the model also named one it cannot", () => {
    // ONE LIST, both ways. A candidate named in the question and recorded
    // against nobody is a question that comes back on every run however it is
    // answered: the answer reader has no key to write it to, so nothing about it
    // ever changes.
    const { ask, raised } = discover({
      scope: scopeOf(),
      raw: unsureProposal(
        ["acme/web", "the ticket names the dashboard"],
        ["acme/secret", "a guess at the billing service"],
      ),
    });

    expect(ask?.askedRepositories).toEqual([
      { repositoryKey: "github:acme/web", askedBecause: "selection" },
    ]);
    expect(raised.questions[0]).toContain("github:acme/web");
    expect(raised.questions[0]).not.toContain("github:acme/secret");
  });

  it("asks about the one repository by name when nothing the model proposed resolves", () => {
    // The candidate question may only name what it can record, so a proposal
    // the catalog does not hold is no candidate at all. It falls through to the
    // refusal, which names that repository and records the answer against it.
    // The old shape asked a candidate question naming a key it recorded against
    // nobody, so the answer was dropped and the identical question came back on
    // the next run, and the one after that (A46).
    const { ask, raised } = discover({
      scope: scopeOf(),
      raw: unsureProposal(["acme/secret", "a guess at the billing service"]),
    });

    expect(ask?.askedRepositories).toEqual([
      { repositoryKey: "github:acme/secret", askedBecause: "not_enabled" },
    ]);
    expect(raised.questions).toEqual([
      "Repository discovery asked for github:acme/secret, which this run cannot use:" +
        " it is not enabled on this deployment." +
        " Enable it on the Repositories page and start a new run to use it." +
        " Or name only the repositories to use.",
    ]);
  });

  it("asks a run that froze no record the same sentence, and leaves nothing on its context", () => {
    const withoutRecord = discover({
      raw: unsureProposal(["acme/web", "the ticket names the dashboard"]),
    });
    const withRecord = discover({
      scope: scopeOf(),
      raw: unsureProposal(["acme/web", "the ticket names the dashboard"]),
    });

    expect(withoutRecord.raised.questions).toEqual(withRecord.raised.questions);
    expect(withoutRecord.ask).toBeUndefined();
  });

  it("gives a second question in the same run its own repositories, never these", () => {
    // The park chain TAKES the field as it reads it, so a candidate list must
    // not survive into the next question of the same run.
    const ctx = makeCtx({
      workScope: {
        subjectKey: SUBJECT,
        scope: scopeOf(entry("github:acme/api", "excluded")),
        selectionAnswered: false,
      },
    });
    const door = createRepositoryQuestions(ctx);

    const first = discover({
      ctx,
      door,
      scope: scopeOf(entry("github:acme/api", "excluded")),
      raw: unsureProposal(["acme/web", "the ticket names the dashboard"]),
    });
    const second = discover({
      ctx,
      door,
      scope: scopeOf(entry("github:acme/api", "excluded")),
      raw: proposal("acme/secret", "the ticket names the billing service"),
    });

    expect(first.ask?.askedRepositories).toEqual([
      { repositoryKey: "github:acme/web", askedBecause: "selection" },
    ]);
    expect(second.ask?.askedRepositories).toEqual([
      { repositoryKey: "github:acme/secret", askedBecause: "not_enabled" },
    ]);
  });

  it("never turns a person's \"none\" into an attach of the repository they declined", () => {
    // SILENCE IS NOT SELECTION. Suppressing the question is not permission to
    // act on what it would have offered: a person asked "which of these should
    // I start from" who answered "none of these" REFUSED the dashboard, and a
    // later run attaching it executes their refusal as consent, silently.
    const { decision, ctx } = decide({
      scope: scopeOf(),
      answeredRepositoryKeys: ["github:acme/web"],
      mandatory: [
        {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "the pull request this run was triggered by",
        },
      ],
      raw: unsureProposal(["acme/web", "the ticket names the dashboard"]),
    });

    expect(decision).toMatchObject({
      kind: "selected",
      repositories: [{ provider: "github", repoPath: "acme/api" }],
      leftOut: [
        {
          repositoryKey: "github:acme/web",
          reason:
            "Repository discovery was not confident about github:acme/web," +
            " and somebody on this work was already asked which repositories to start from" +
            " and did not name it, so this run left it out rather than acting on a question" +
            " nobody answered with it.",
        },
      ],
    });
    expect(consumeWorkScopeAsk(ctx)).toBeUndefined();
  });

  it("is asked once per repository, and afterwards stops rather than asking again", () => {
    // A "none" to this question writes no entry by design, so without a stop the
    // next run reads exactly what this one read, the model repeats its
    // proposal, and the identical question is posted again. That is the A47
    // loop, on the question this wave added. Nothing is attached on the way out.
    const { decision, ctx } = decide({
      scope: scopeOf(),
      answeredRepositoryKeys: ["github:acme/web"],
      raw: unsureProposal(["acme/web", "the ticket names the dashboard"]),
    });

    expect(decision).toEqual({
      kind: "failed",
      error:
        "Repository discovery was not confident about github:acme/web," +
        " and somebody on this work was already asked which repositories to start from" +
        " and did not name it. Not naming a repository is not choosing it," +
        " so this run has no repository to work on." +
        // A comment, not the ticket itself: a description edit is the text the
        // question was already asked about and binds nothing (C11f, R3).
        " Write the full path of each repository this ticket should work on in a comment on this" +
        " ticket, as github:acme/web, and start a new run.",
      blame: "work_scope",
    });
    expect(consumeWorkScopeAsk(ctx)).toBeUndefined();
  });

  it("never offers a repository this run could not clone even if they picked it", () => {
    const catalog = [...CATALOG, catalogEntry("github", "acme/fresh", false)];

    const { ask } = discover({
      scope: scopeOf(),
      catalog,
      raw: unsureProposal(
        ["acme/web", "the ticket names the dashboard"],
        ["acme/fresh", "the ticket names the new service"],
      ),
    });

    expect(ask?.askedRepositories).toEqual([
      { repositoryKey: "github:acme/web", askedBecause: "selection" },
    ]);
  });

  it("leaves the run context empty for the next question, when that one names nothing", () => {
    // The candidates are the first list on this path long enough for the leak to
    // matter, and the question after them is the one that names nothing: a
    // person answering "yes" to it would settle a selection among repositories
    // nobody showed them. Read WITHOUT consuming in between, because consuming
    // clears the field and would hide the door failing to assign.
    const ctx = makeCtx({
      workScope: { subjectKey: SUBJECT, scope: scopeOf(), selectionAnswered: false },
    });
    const door = createRepositoryQuestions(ctx);
    const raiseThrough = (raw: unknown) => {
      const { decision } = decide({ ctx, scope: scopeOf(), raw });
      if (decision.kind !== "clarification_needed") {
        throw new Error(`discovery decided ${decision.kind}, not a question`);
      }
      const { questions, ask } = repositoryDiscoveryQuestion({
        decision,
        subjectKey: SUBJECT,
        recorded: [],
        catalog: CATALOG,
      });
      door.raise(questions, ask);
    };

    raiseThrough(unsureProposal(["acme/web", "the ticket names the dashboard"]));
    expect(ctx.workScopeAsk?.askedRepositories).toEqual([
      { repositoryKey: "github:acme/web", askedBecause: "selection" },
    ]);

    // The model asking for clarification itself is the question that names no
    // repository: it is about the model's behaviour, and there is nothing an
    // answer to it could be recorded against.
    raiseThrough({
      status: "clarification_needed",
      confidence: null,
      repositories: null,
      questions: null,
      error: null,
    });
    expect(ctx.workScopeAsk).toBeUndefined();
  });
});

/**
 * A subject is ASKED once and TOLD afterwards (A47).
 *
 * A person who answered the excluded question above with "none" was asked it
 * again after every answer: a `selection` question writes no entry by design, so
 * nothing the next run reads had changed, the model named the same repository
 * out of the ticket text, and the same sentence was posted again. Each turn cost
 * a planning agent run, a ticket comment and two ticket transitions, and only
 * the person giving up ended it.
 */
describe("a subject whose selection question has already been answered", () => {
  const PROPOSES_BOTH = {
    status: "selected",
    confidence: "high",
    repositories: [
      { provider: "github", repoPath: "acme/api", rationale: "the ticket names the API schema" },
      { provider: "github", repoPath: "acme/web", rationale: "the ticket names the dashboard" },
    ],
    questions: null,
    error: null,
  };

  it("does not park, drops the repository the record decided, and runs with what is left", () => {
    const { decision, ctx } = decide({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      selectionAnswered: true,
      answeredRepositoryKeys: ["github:acme/api"],
      raw: PROPOSES_BOTH,
    });

    expect(decision).toMatchObject({
      kind: "selected",
      repositories: [{ provider: "github", repoPath: "acme/web" }],
      leftOut: [
        {
          repositoryKey: "github:acme/api",
          reason:
            "github:acme/api was excluded on this work by Ada Lovelace on 2026-09-10," +
            " and this run left it out rather than asking about it again.",
        },
      ],
    });
    expect(consumeWorkScopeAsk(ctx)).toBeUndefined();
  });

  it("carries the dropped repository as a key, so the run itself can say what it left out", () => {
    // The prose goes into the agent's prompt and reaches nobody else. The key
    // is what the run observation carries, which is where the person who
    // excluded it can find out why their ticket's other repository was never
    // opened.
    const { decision } = decide({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      selectionAnswered: true,
      answeredRepositoryKeys: ["github:acme/api"],
      raw: PROPOSES_BOTH,
    });

    expect(decision).toMatchObject({ droppedRepositoryKeys: ["github:acme/api"] });
  });

  it("puts that drop on the run, not only in the agent's prompt", () => {
    // A source tripwire, in the style of the parking one in
    // `work-scope-expansion.test.ts`: the emit sits in a closure inside
    // `agentWorkflowBody` that no test can invoke, and the whole point of the
    // observation is that it reaches a reader the prompt never does.
    const workflow = readFileSync(
      fileURLToPath(new URL("../agent-workflow.ts", import.meta.url)),
      "utf8",
    );

    expect(
      workflow.includes('event: "work_scope_drop"'),
      "the discovery drop no longer reaches the run trace, so it reaches only the agent",
    ).toBe(true);
    expect(
      workflow.includes("decision.droppedRepositoryKeys.length > 0"),
      "the drop observation is no longer raised from what the decision actually dropped",
    ).toBe(true);
  });

  it("carries what it left out into the comment a finished run posts, not only the prompt", () => {
    // The same tripwire shape, for the same reason: the closure that decides the
    // drop cannot be invoked by a test, and neither can the report build far
    // below it. The prompt reaches the agent and the observation reaches a
    // query; the person who excluded the repository reads neither. Without this
    // they read an ordinary success comment on a run that opened less than the
    // ticket names, and nothing anywhere says why.
    const workflow = readFileSync(
      fileURLToPath(new URL("../agent-workflow.ts", import.meta.url)),
      "utf8",
    );

    expect(
      workflow.includes("decision.leftOut.filter("),
      "the discovery drop no longer reaches the run's analysis report",
    ).toBe(true);
    // Every research report this body builds, not one of them: the run reaches
    // the builder down two paths (a no-change finish and an ordinary one) and a
    // drop is equally invisible on either.
    expect(
      workflow.split("leftOutRepositories,").length - 1,
      "a research analysis report is built without what the run left out",
    ).toBe(2);
  });

  it("carries what a person can do about it into the same comment", () => {
    // The same tripwire, for the sentence beside the list. The comment is the
    // only surface that reaches a person on a run that FINISHED: the
    // pre-sandbox halt text reaches nobody when the run does not halt, and the
    // prompt additions reach the agent. Composed through the shared helpers so a
    // person reads one wording on every path, and guarded on the record so only
    // a decision a person made (an exclusion, a repository left out of an
    // answer) is described as one they can take back.
    const workflow = readFileSync(
      fileURLToPath(new URL("../agent-workflow.ts", import.meta.url)),
      "utf8",
    );

    expect(
      /const unnamedLeftOut = leftOutKeys\.filter\(\(key\) =>\s*isUnnamedInAnswer\([\s\S]{0,400}?repositoryRecoveryNotes = \[\s*\.\.\.unnamedRecoveryNotes\(\s*unnamedLeftOut,[\s\S]{0,400}?record\?\.commentPathIsTaken\(unnamedLeftOut\)/.test(
        workflow,
      ),
      "the discovery path no longer tells a person leaving a repository out of an answer can be taken back",
    ).toBe(true);
    expect(
      /\.\.\.exclusionRecoveryNotes\(\s*leftOutKeys\.filter\(\(key\) => excludedKeys\.has\(key\)\)/.test(
        workflow,
      ),
      "the discovery path no longer tells a person the exclusion can be taken back",
    ).toBe(true);
    expect(
      workflow.includes("repositoryRecoveryNotes = [...record.recoveryNotes]"),
      "the expansion path computes the recovery sentence and throws it away again",
    ).toBe(true);
    expect(
      workflow.split("repositoryRecoveryNotes,").length - 1,
      "a research analysis report is built without the sentence saying what to do about it",
    ).toBe(2);
  });

  it("carries an expansion refusal to a person, not only to the model", () => {
    // `expansionRefusals` becomes a prompt addition and nothing else, so a run
    // that refused half of what it was asked for finishes green with nothing
    // anywhere a person reads. The refusal has to reach the same list the
    // discovery drops reach.
    const workflow = readFileSync(
      fileURLToPath(new URL("../agent-workflow.ts", import.meta.url)),
      "utf8",
    );

    expect(
      workflow.includes("leftOutRepositories.concat({"),
      "an expansion refusal no longer reaches the comment a finished run posts",
    ).toBe(true);
  });

  it("starts both lists from what the pre-sandbox already refused", () => {
    // The silent case, and the one hop of it no test can invoke: the workflow
    // body seeds from the run context. Empty seeds here mean a run that
    // refused a repository in selection, did NOT halt and finished green tells
    // the person nothing, because every other surface on this path reaches
    // them only when the run stops.
    const workflow = readFileSync(
      fileURLToPath(new URL("../agent-workflow.ts", import.meta.url)),
      "utf8",
    );

    expect(
      workflow.includes("...(ctx.workScopeLeftOut ?? []),"),
      "the run no longer carries the pre-sandbox refusals into its analysis report",
    ).toBe(true);
    expect(
      workflow.includes("[...(ctx.workScopeRecoveryNotes ?? [])]"),
      "the run no longer carries the pre-sandbox recovery sentence into its analysis report",
    ).toBe(true);
    // Added to rather than replaced, because one run can reach all three
    // deciders and the later ones would otherwise erase the first.
    expect(
      workflow.includes("leftOutRepositories = decision.leftOut;"),
      "discovery overwrites the pre-sandbox refusals instead of adding to them",
    ).toBe(false);
  });

  it("decides the drop on what THIS subject was asked about, off the run context", () => {
    // The same tripwire shape, for the same reason: the closure that hands the
    // validator what this subject settled cannot be invoked by a test. Handing
    // it the subject-wide flag alone is the defect this wave exists to close,
    // and the empty default is what keeps a run resuming from a context frozen
    // before the fact existed asking rather than dropping.
    const workflow = readFileSync(
      fileURLToPath(new URL("../agent-workflow.ts", import.meta.url)),
      "utf8",
    );

    expect(
      workflow.includes("answeredRepositoryKeys: ctx.workScope.answeredRepositoryKeys ?? []"),
      "the discovery closure no longer tells the validator WHICH repositories this subject" +
        " was asked about, so a drop is decided on a subject-wide flag again",
    ).toBe(true);
  });

  it("re-reads the record after an answer, so the block that asked does not ask again", () => {
    // THE RUN HANGS WITHOUT THIS, and a hanging run outranks both a repeated
    // question and a fabricated decision. A discovery answer resumes the SAME
    // run and the block is re-executed from the top; it decides against
    // `ctx.workScope`, and left as the run froze it at start that still says
    // nobody was ever asked. So discovery reaches the same line, raises the
    // identical question, and the person answers into a loop that ends only when
    // the run budget kills it. The expansion path already re-reads inside its
    // own resume step; this is the same read on the door every other repository
    // question goes through, and the door is a closure no test can invoke.
    const workflow = readFileSync(
      fileURLToPath(new URL("../agent-workflow.ts", import.meta.url)),
      "utf8",
    );

    // Whitespace collapsed, because the call spans lines and the fact being
    // guarded is which arguments go with it, not how the formatter broke them.
    expect(
      workflow
        .replace(/\s+/g, " ")
        .includes(
          "const resumed = await readWorkScopeAfterAnswerStep( workScopeAsk.subjectKey, clarification.id, );",
        ),
      "a run that asked a repository question no longer re-reads the record after the" +
        " answer, or no longer says WHICH question it is waking on, so the block that" +
        " asked decides against the record as it was BEFORE it, or against a verdict it" +
        " cannot have, and asks the same person the same question until the budget kills" +
        " the run",
    ).toBe(true);
    expect(
      workflow.includes("ctx.workScope = { ...ctx.workScope, ...resumed };"),
      "the record read after the answer no longer reaches the run context",
    ).toBe(true);
  });

  it("stops, naming who excluded it, and tells that person how to take the exclusion back", () => {
    // NOBODY IS ASKED TWICE, and the empty result set is not an exception. This
    // repository is here only because a question naming it was already put and
    // somebody answered it, so the second question would be the same question
    // to the same person for the same answer. The run stops and says whose
    // decision left it with nothing, which is the person whose next move it is.
    //
    // And their next move is a real one now. The closing sentence comes from
    // exclusionRecoveryNotes, the single source for what anybody is told about
    // taking an exclusion back; it used to send the person to a new ticket,
    // which threw away every decision already recorded and is false now that
    // the list on this work can be edited.
    const { decision, ctx } = decide({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      answeredRepositoryKeys: ["github:acme/api"],
      raw: proposal("acme/api", "the ticket names the API schema"),
    });

    expect(decision).toEqual({
      kind: "failed",
      error:
        "github:acme/api was excluded on this work by Ada Lovelace on 2026-09-10." +
        " Repository discovery proposed nothing else this run can use," +
        " so it has no repository to work on." +
        " Excluding a repository is not final: this work's repository list can be changed" +
        " through the work scope API or the work_scope.edit tool," +
        " and the next run starts from the changed list.",
      blame: "work_scope",
    });
    expect(consumeWorkScopeAsk(ctx)).toBeUndefined();
  });

  it("asks about the excluded repository the FIRST time, because nobody has seen it yet", () => {
    // Wave 8's question, and the first half of the rule: A44 promises one ask.
    const { raised, ask } = discover({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      answeredRepositoryKeys: [],
      raw: proposal("acme/api", "the ticket names the API schema"),
    });

    expect(raised.questions[0]).toContain("was excluded on this work by Ada Lovelace");
    expect(ask?.askedRepositories).toEqual([
      { repositoryKey: "github:acme/api", askedBecause: "selection" },
    ]);
  });

  it("does NOT ask the SECOND time, once somebody answered the question about it", () => {
    // The second half: the same subject, the same record, the same proposal, and
    // the one thing that changed is that the question above was answered. The
    // run now tells rather than asks (A47).
    const { decision, ctx } = decide({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      answeredRepositoryKeys: ["github:acme/api"],
      raw: PROPOSES_BOTH,
    });

    expect(decision).toMatchObject({
      kind: "selected",
      leftOut: [
        {
          repositoryKey: "github:acme/api",
          reason:
            "github:acme/api was excluded on this work by Ada Lovelace on 2026-09-10," +
            " and this run left it out rather than asking about it again.",
        },
      ],
    });
    expect(consumeWorkScopeAsk(ctx)).toBeUndefined();
  });

  it('answering "none" does not arm the silent drop of a repository somebody ELSE excluded', () => {
    // The fact that silences a repository has to be about THAT repository. A
    // person who answered "none of these" to a low confidence question about the
    // dashboard has said nothing about the API schema somebody else took off
    // this work, and a subject-wide flag cannot tell the two apart: gating on it
    // drops the API schema without ever having put it to anybody, which is the
    // one ask A44 promises, spent on a question nobody was asked.
    const { raised, ask } = discover({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      // What that answer leaves behind: the subject has been answered, and the
      // repository it was about is the OTHER one.
      selectionAnswered: true,
      answeredRepositoryKeys: ["github:acme/web"],
      raw: proposal("acme/api", "the ticket names the API schema"),
    });

    expect(raised.questions[0]).toContain("github:acme/api was excluded on this work");
    expect(ask?.askedRepositories).toEqual([
      { repositoryKey: "github:acme/api", askedBecause: "selection" },
    ]);
  });

  it("asks again on a run resuming from a context frozen before the fact existed", () => {
    // The absence of the set is not "everything was answered", it is "nothing is
    // known to have been asked". A run replaying a run-start result written by
    // the previous deployment carries no set at all, and the only acceptable
    // cost direction is one more question rather than a silent drop.
    const { raised } = discover({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      selectionAnswered: true,
      raw: proposal("acme/api", "the ticket names the API schema"),
    });

    expect(raised.questions[0]).toContain("github:acme/api was excluded on this work");
  });

  it("still raises the excluded question when a duplicate was proposed beside it", () => {
    // The duplicate used to return first and take the rest of the proposal with
    // it, so the refusal that matters was never reached.
    const { raised } = discover({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      raw: {
        status: "selected",
        confidence: "high",
        repositories: [
          { provider: "github", repoPath: "acme/web", rationale: "one" },
          { provider: "github", repoPath: "ACME/WEB", rationale: "two" },
          { provider: "github", repoPath: "acme/api", rationale: "the ticket names the API schema" },
        ],
        questions: null,
        error: null,
      },
    });

    expect(raised.questions[0]).toContain("github:acme/api was excluded on this work");
  });
});

/**
 * What the person's answer does, read the way the answer path reads it.
 *
 * The question reaches them numbered and published by the ticket comment, and a
 * reply composed from ticket comments carries an author prefix, so a defence
 * that compared an answer against the question AS STORED would fire on no real
 * channel at all. These go through the real comment builder for that reason.
 */
describe("the answer to the excluded question settles it", () => {
  const QUESTION =
    "github:acme/api was excluded on this work by Ada Lovelace on 2026-09-10." +
    ' Repository discovery asked for it anyway, because "the ticket names the API schema".' +
    " Answer with github:acme/api to take that exclusion back and let this run use it," +
    " or name only the repositories to use.";

  /** The question as the ticket comment actually posts it: numbered, published. */
  function postedQuestion(): string {
    const block = formatClarificationQuestionsComment({
      questions: [QUESTION],
      suggestedAnswers: null,
      dashboardUrl: "https://dashboard.example/tickets/AWT-1",
      aiColumnName: "Ai",
      expiresAtIso: null,
    })
      .split("\n\n")
      .find((section) => section.startsWith("1. "));
    if (!block) throw new Error("the questions comment no longer numbers its questions");
    return block;
  }

  function read(answer: string): WorkScopeQuestionAnswer {
    return readRepositoryAnswer(answer, {
      // A third repository nobody asked about, because a person redirecting us
      // answers out of the whole catalog rather than out of the question, and
      // a fourth whose name carries an underscore, which is an ordinary
      // repository name and not markdown.
      catalogKeys: [
        "github:acme/web",
        "github:acme/api",
        "github:acme/docs",
        "github:acme/my_repo",
      ],
      askedKeys: ["github:acme/api"],
      askedQuestions: [QUESTION],
    });
  }

  /** Our question after a phone keyboard or an editor substituted typographic
   *  quotes for the straight ones we wrote the model's words in. */
  function withCurlyQuotes(text: string): string {
    return text.replace(/"([^"]*)"/gu, "“$1”");
  }

  /** The one sentence of the posted question a person quotes when they answer
   *  it, which is the sentence that names the repository. */
  function oneSentenceOfTheQuestion(): string {
    const [first] = postedQuestion().split(/(?<=\.)\s(?=[A-Z])/u);
    if (!first.includes("github:acme/api")) {
      throw new Error("the first sentence of the question no longer names the repository");
    }
    return first;
  }

  /** The answer decided where it arrives, exactly as `recordRepositoryAnswer`
   *  decides it: no policy, no pin, and the person as the actor. */
  function recordAnswer(answer: WorkScopeQuestionAnswer, scope: WorkScope) {
    return decideWorkScope(
      {
        scope,
        carriesRecord: true,
        catalog: {
          activated: true,
          enabledKeys: ["github:acme/web", "github:acme/api"],
          unusableKeys: null,
        },
        pinnedProviders: null,
        pinnedKeys: null,
        policy: null,
        eventRelatedKeys: [],
        attachedKeys: null,
        selectionAnswered: false,
        answeredRepositoryKeys: [],
        postAnswerMentionedKeys: [],
        actor: PERSON_ACTOR,
        now: ANSWERED_AT,
      },
      {
        kind: "answered",
        clarificationId: "clr-1",
        asked: [{ repositoryKey: "github:acme/api", askedBecause: "selection" }],
        answer,
      },
    );
  }

  it("records the repository as selected by the person who named it", () => {
    const answer = read([postedQuestion(), "Ada Lovelace: github:acme/api"].join("\n"));

    expect(answer).toEqual({ kind: "repositories", repositoryKeys: ["github:acme/api"] });
    expect(
      recordAnswer(answer, scopeOf(entry("github:acme/api", "excluded"))).plan.upserts,
    ).toEqual([
      {
        entry: expect.objectContaining({
          repositoryKey: "github:acme/api",
          state: "selected",
          origin: "person",
          decidedBy: PERSON_ACTOR,
          decidedAt: ANSWERED_AT,
        }),
        replacesExpired: false,
      },
    ]);
  });

  it("leaves the exclusion standing and writes no entry when the answer is none", () => {
    const answer = read("none");
    const plan = recordAnswer(answer, scopeOf(entry("github:acme/api", "excluded"))).plan;

    expect(answer).toEqual({ kind: "none" });
    expect(plan.upserts).toEqual([]);
    expect(plan.deletes).toEqual([]);
    // The answer itself is still recorded, so the trail shows a person was
    // asked and said no, with nothing written against the repository.
    expect(plan.trail).toEqual([
      {
        kind: "question_answered",
        clarificationId: "clr-1",
        answer: { kind: "none" },
        answeredBy: PERSON_ACTOR,
      },
    ]);
  });

  /**
   * Our own question, in each shape a real channel sends it back in.
   *
   * This question names the repository twice, so a quote of it IS a naming: a
   * defence that only dropped a whole line equal to our words let every one of
   * these through, and each one then recorded `selected` in the name of the
   * person whose exclusion it was, with no way back until the panel ships.
   */
  const quotedBack = {
    raw: QUESTION,
    numbered: postedQuestion(),
    composed: `Ada Lovelace: ${QUESTION}`,
    "quote marked": `> ${QUESTION}`,
    "quote marked without a space": `>${QUESTION}`,
    "quote marked and re-wrapped by a mail client": QUESTION.replace(
      /(\S+\s\S+\s)/gu,
      "$1\n> ",
    ),
  };

  it.each(Object.entries(quotedBack))(
    "reads our own question sent back as %s as no answer at all",
    (_channel, quoted) => {
      expect(read(quoted)).toEqual({ kind: "unrecognised" });
    },
  );

  it("reads our own question with a few words typed after it as no answer at all", () => {
    // The inline paste: a person pastes the question and types beside it, so
    // nothing on that line is a whole line of ours.
    expect(read(`${QUESTION} please confirm`)).toEqual({ kind: "unrecognised" });
  });

  it("reads a yes under a quoted question as a yes", () => {
    // The most natural reply in a ticket, and the one this question invites.
    // Every rule reads what is left after our words come out, so the plain-yes
    // rule is no longer looking at the quote as well.
    expect(read([postedQuestion(), "yes"].join("\n"))).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/api"],
    });
  });

  it("still reads the repository a person names under a quote of the question", () => {
    expect(read([`> ${QUESTION}`, "github:acme/api"].join("\n"))).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/api"],
    });
  });

  /**
   * A person who quotes PART of our question and refuses under it.
   *
   * The quote carries our repository key, so the refusal below it was read as
   * the person naming that key: the exclusion they were asked about came back
   * as their own selection, in their name. Our own copy ends with "or with the
   * repositories this ticket should use instead", so these are the words we
   * taught them to answer with.
   */
  it.each([
    ["none", "none"],
    ["none of these", "none of these"],
  ])(
    "reads a quote of one sentence of our question with %s under it as a decline",
    (_what, said) => {
      // Round 4, and this changed meaning. The danger was always one way round:
      // our key in the quote being read as their choice, and that is still
      // refused. Their own word is "none", written into the box this question
      // opened, so it declines what the question asked about instead of costing
      // them a round.
      expect(read([`> ${oneSentenceOfTheQuestion()}`, said].join("\n"))).toEqual({
        kind: "none",
      });
    },
  );

  it("reads a quote of the whole question with none under it as a decline", () => {
    expect(read([`> ${postedQuestion()}`, "none"].join("\n"))).toEqual({ kind: "none" });
  });

  it("reads our own question sent back after a keyboard turned the quotes curly as no answer at all", () => {
    // The question embeds the model's words in straight double quotes, and a
    // phone keyboard or an editor substitutes typographic ones. Matched
    // literally, the copy is no longer ours, and this answer, which is nothing
    // but our question, was read as the person naming the repository in it.
    expect(read(`> ${withCurlyQuotes(postedQuestion())}`)).toEqual({ kind: "unrecognised" });
  });

  it("reads a none under a quote a keyboard turned curly as a decline", () => {
    expect(read([`> ${withCurlyQuotes(postedQuestion())}`, "none"].join("\n"))).toEqual({
      kind: "none",
    });
  });

  it("reads our own question sent back with non-breaking spaces as no answer at all", () => {
    expect(read(`> ${postedQuestion().replace(/ /gu, " ")}`)).toEqual({
      kind: "unrecognised",
    });
  });

  it("reads our own question sent back in bold as no answer at all", () => {
    expect(read(`> **${postedQuestion()}**`)).toEqual({ kind: "unrecognised" });
  });

  /**
   * A person who answers with a different repository INSTEAD of the excluded
   * one, in every phrasing this reader used to resolve.
   *
   * ROUND 4, AND THIS WHOLE GROUP CHANGED MEANING. Each of these was read as
   * two decisions at once: the refusal it states and the choice beside it. The
   * reader that can do that is the reader that decided "please do not touch
   * github:acme/billing" was a choice of billing, because the difference
   * between them is phrasing rather than intent, and the ways people write a no
   * do not end. So a reply that says no about anything records nothing, in
   * every language, and the person is told to name only the repositories to
   * use. A round is cheap; a decision recorded against somebody who wrote the
   * opposite is not.
   */
  it.each([
    "use acme/web instead of acme/api",
    "acme/web rather than acme/api",
    "drop acme/api, keep acme/web",
    "ignore acme/api, use acme/web",
    "forget acme/api, use acme/web",
    "acme/api is out of scope, use acme/web",
    "remove acme/api, use acme/web",
    "acme/web, not acme/api",
    "zamiast acme/api uzyj acme/web",
    "nie bierz acme/api, zamiast tego acme/web",
    "pomin acme/api, uzyj acme/web",
    "usun acme/api, uzyj acme/web",
  ])("records nothing and asks again when a person wrote %s", (said) => {
    expect(read(said)).toEqual({ kind: "unrecognised" });
  });

  // And the same reply under our own question: taking our words out changes
  // nothing about it, because what is left still says no.
  it("records nothing from a redirection written under our posted question", () => {
    const answer = [postedQuestion(), "Ada Lovelace: use acme/web instead of acme/api"].join("\n");

    expect(read(answer)).toEqual({ kind: "unrecognised" });
  });

  // The reply the rule asks for, in place of every phrasing above: the
  // repository to use, and nothing else. It is the one sentence our copy sends
  // people back with, so it has to work.
  it("records the repository when a person names only the one to use", () => {
    expect(read("acme/web")).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/web"],
    });
    expect(read("use acme/web")).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/web"],
    });
  });

  it("asks again when the only repository a person excepted is the one we asked about", () => {
    // Nothing is left to attach and nothing is written: an excepted key is not
    // a selection, and a refusal of the whole question is not ours to infer.
    expect(read("everything except acme/api")).toEqual({ kind: "unrecognised" });
  });

  it("gives the in-run expansion reader the same protection from one helper", () => {
    // Both readers of one answer take our words out through
    // `withoutQuotedQuestions`. Two readers that disagreed about which words
    // were ours would record one decision and attach another.
    expect(
      validateHumanRepositoryExpansion({
        answer: `> ${QUESTION}`,
        catalog: CATALOG,
        attached: [],
        askedQuestions: [QUESTION],
      }).kind,
    ).toBe("unrecognised_answer");
  });

  it("gives that reader the same protection after a keyboard turned the quotes curly", () => {
    // The in-run reader attaches what an answer names and has no refusal word
    // standing between a quote and an attach, so this is where the strip is
    // read on its own: our question, sent back with typographic quotes and
    // nothing else, attaches the repository in OUR sentence unless the two
    // sides are compared with the same quotes.
    expect(
      validateHumanRepositoryExpansion({
        answer: `> ${withCurlyQuotes(QUESTION)}`,
        catalog: CATALOG,
        attached: [],
        askedQuestions: [QUESTION],
      }).kind,
    ).toBe("unrecognised_answer");
  });

  it("still resolves a repository whose name carries an underscore", () => {
    // The emphasis normalisation drops ASTERISKS from both sides of the
    // comparison, and must never touch underscores: an underscore is legal in
    // a repository path, so folding it away would corrupt the very names this
    // reader exists to read. This test is red the moment that class is widened
    // to `[*_]`, because "acme/my_repo" would resolve to nothing and a person
    // who named their repository correctly would be asked all over again.
    expect(read("use acme/my_repo")).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/my_repo"],
    });
  });

  it("gives that reader the same protection when a person bolded one word inside the quote", () => {
    // Markdown emphasis inside the quote makes our sentence stop being ours by
    // two characters, and the in-run reader has no refusal word standing
    // between a quote and an attach: before this, it attached the repository
    // OUR question named. Proved here rather than at the record reader, which
    // survives this by accident of the word "instead" in today's copy and
    // would stop surviving it the moment that copy is rewritten.
    expect(
      validateHumanRepositoryExpansion({
        answer: `> ${QUESTION.replace("excluded", "**excluded**")}`,
        catalog: CATALOG,
        attached: [],
        askedQuestions: [QUESTION],
      }).kind,
    ).toBe("unrecognised_answer");
  });

  it("gives that reader the same protection when a channel flattened the bold we asked in", () => {
    // The other direction, and the one that proves the QUESTION side: the
    // emphasis is in the question we asked, and the channel that carried the
    // quote back dropped it (Jira's adapter flattens a document to text). Only
    // taking the asterisks off both sides makes those one sentence.
    const asked = QUESTION.replace("excluded", "**excluded**");

    expect(
      validateHumanRepositoryExpansion({
        answer: `> ${QUESTION}`,
        catalog: CATALOG,
        attached: [],
        askedQuestions: [asked],
      }).kind,
    ).toBe("unrecognised_answer");
  });

  it("gives that reader the same protection when the model's own words carried curly quotes", () => {
    // The rationale inside the question is the model's writing, so the curly
    // quotes can be ours: the question we ASKED carries them, and the person
    // quotes it back exactly as it reached them. The question side needs the
    // same normalisation as the answer side for those to be one sentence.
    const asked = withCurlyQuotes(QUESTION);
    expect(
      validateHumanRepositoryExpansion({
        answer: `> ${asked}`,
        catalog: CATALOG,
        attached: [],
        askedQuestions: [asked],
      }).kind,
    ).toBe("unrecognised_answer");
  });
});

/**
 * What a person's answer to the LOW CONFIDENCE question does, read the way the
 * answer path reads it.
 *
 * The question reaches them numbered and published by the ticket comment, and a
 * reply composed from ticket comments carries an author prefix, so a defence
 * that compared an answer against the question AS STORED would fire on no real
 * channel at all. These go through the real comment builder for that reason.
 *
 * `github:acme/app` is in the catalog these tests read against ON PURPOSE. Our
 * own copy names it as the example of a provider-scoped path, so a deployment
 * that happens to hold a repository by that name is the case where nothing but
 * `withoutQuotedQuestions` stands between a quote of our question and a
 * selection recorded in that person's name for a repository nobody proposed.
 */
describe("the answer to the unsure question settles it", () => {
  const QUESTION =
    "Repository discovery was not confident enough to select automatically." +
    " Which repository or repositories should this ticket inspect or modify?" +
    " Reply with full provider-scoped paths (for example github:acme/app)." +
    " Proposed candidates: github:acme/web (the ticket names the dashboard)," +
    " github:acme/api (the ticket names the API schema).";

  const ASKED: WorkScopeAskedRepository[] = [
    { repositoryKey: "github:acme/web", askedBecause: "selection" },
    { repositoryKey: "github:acme/api", askedBecause: "selection" },
  ];

  /** The question as the ticket comment actually posts it: numbered, published. */
  function postedQuestion(): string {
    const block = formatClarificationQuestionsComment({
      questions: [QUESTION],
      suggestedAnswers: null,
      dashboardUrl: "https://dashboard.example/tickets/AWT-1",
      aiColumnName: "Ai",
      expiresAtIso: null,
    })
      .split("\n\n")
      .find((section) => section.startsWith("1. "));
    if (!block) throw new Error("the questions comment no longer numbers its questions");
    return block;
  }

  function read(answer: string): WorkScopeQuestionAnswer {
    return readRepositoryAnswer(answer, {
      catalogKeys: ["github:acme/web", "github:acme/api", "github:acme/app"],
      askedKeys: ASKED.map((asked) => asked.repositoryKey),
      askedQuestions: [QUESTION],
    });
  }

  /** The answer decided where it arrives, exactly as `recordRepositoryAnswer`
   *  decides it: no policy, no pin, and the person as the actor. */
  function recordAnswer(answer: WorkScopeQuestionAnswer, scope: WorkScope) {
    return decideWorkScope(
      {
        scope,
        carriesRecord: true,
        catalog: {
          activated: true,
          enabledKeys: ["github:acme/web", "github:acme/api", "github:acme/app"],
          unusableKeys: null,
        },
        pinnedProviders: null,
        pinnedKeys: null,
        policy: null,
        eventRelatedKeys: [],
        attachedKeys: null,
        selectionAnswered: false,
        answeredRepositoryKeys: [],
        postAnswerMentionedKeys: [],
        actor: PERSON_ACTOR,
        now: ANSWERED_AT,
      },
      { kind: "answered", clarificationId: "clr-2", asked: ASKED, answer },
    );
  }

  it("records the candidate a person named as selected by them", () => {
    const answer = read([postedQuestion(), "Ada Lovelace: github:acme/api"].join("\n"));

    expect(answer).toEqual({ kind: "repositories", repositoryKeys: ["github:acme/api"] });
    expect(recordAnswer(answer, scopeOf()).plan.upserts).toEqual([
      {
        entry: expect.objectContaining({
          repositoryKey: "github:acme/api",
          state: "selected",
          origin: "person",
          decidedBy: PERSON_ACTOR,
          decidedAt: ANSWERED_AT,
        }),
        replacesExpired: false,
      },
    ]);
  });

  it("writes no entry for none, and leaves every earlier decision standing", () => {
    // This is why `selection` is the reason these candidates are asked under: a
    // person who says none has silenced nothing permanently, and the run
    // proceeds exactly as it does today.
    const answer = read("none");
    const plan = recordAnswer(answer, scopeOf(entry("github:acme/docs", "excluded"))).plan;

    expect(answer).toEqual({ kind: "none" });
    expect(plan.upserts).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.trail).toEqual([
      {
        kind: "question_answered",
        clarificationId: "clr-2",
        answer: { kind: "none" },
        answeredBy: PERSON_ACTOR,
      },
    ]);
  });

  /** Our own question, in each shape a real channel sends it back in. This one
   *  names three repository keys, so a quote of it is three namings. */
  const quotedBack = {
    raw: QUESTION,
    numbered: postedQuestion(),
    composed: `Ada Lovelace: ${QUESTION}`,
    "quote marked": `> ${QUESTION}`,
    "quote marked and re-wrapped by a mail client": QUESTION.replace(/(\S+\s\S+\s)/gu, "$1\n> "),
  };

  it.each(Object.entries(quotedBack))(
    "reads our own question sent back as %s with a word added as no answer at all",
    (_channel, quoted) => {
      expect(read([quoted, "please confirm"].join("\n"))).toEqual({ kind: "unrecognised" });
    },
  );

  it("records nothing at all for an answer nobody could read", () => {
    expect(recordAnswer({ kind: "unrecognised" }, scopeOf()).plan.upserts).toEqual([]);
  });
});
