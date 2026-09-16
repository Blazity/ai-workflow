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
import { consumeWorkScopeAsk, createRunWorkScopeRecorder } from "../work-scope/context.js";
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

/**
 * One pass of the discovery closure: the record filters the catalog, the
 * validator decides against that filtered list, and the question goes through
 * the one door that puts what it asks about on the run context.
 *
 * `scope` undefined is a run that froze no record, which is every run before
 * this feature shipped.
 */
function discover(input: {
  raw: unknown;
  scope?: WorkScope | null;
  catalog?: RepositoryCatalogEntry[];
  door?: ReturnType<typeof createRepositoryQuestions>;
  ctx?: ReturnType<typeof makeCtx>;
}) {
  const catalog = input.catalog ?? CATALOG;
  const ctx =
    input.ctx ??
    makeCtx(
      input.scope === undefined
        ? {}
        : { workScope: { subjectKey: SUBJECT, scope: input.scope, selectionAnswered: false } },
    );
  const record =
    input.scope === undefined
      ? null
      : createRunWorkScopeRecorder({
          subjectKey: SUBJECT,
          scope: input.scope,
          selectionAnswered: false,
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
  const decision = validateRepositoryDiscoveryResult(input.raw, offered, []);
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
        " or with the repositories this ticket should use instead.",
    ]);
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

describe("a discovery question about a repository nobody decided keeps today's words", () => {
  it("asks the enable hint for a repository the catalog does not hold, and carries it as not_enabled", () => {
    const { raised, ask } = discover({
      scope: scopeOf(entry("github:acme/api", "excluded")),
      raw: proposal("acme/secret", "the ticket names the billing service"),
    });

    expect(raised.questions).toEqual([
      "Which repository or repositories should this ticket inspect or modify?" +
        " Reply with full repository paths." +
        " Enable it on the Repositories page, or answer with another repository.",
    ]);
    expect(ask?.askedRepositories).toEqual([
      { repositoryKey: "github:acme/secret", askedBecause: "not_enabled" },
    ]);
  });

  it("carries a repository the catalog holds and cannot use as unusable", () => {
    const catalog = [...CATALOG, catalogEntry("github", "acme/fresh", false)];

    const { ask } = discover({
      scope: scopeOf(),
      catalog,
      raw: proposal("acme/fresh", "the ticket names the new service"),
    });

    expect(ask?.askedRepositories).toEqual([
      { repositoryKey: "github:acme/fresh", askedBecause: "unusable" },
    ]);
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
      "Which repository or repositories should this ticket inspect or modify?" +
        " Reply with full repository paths." +
        " Enable it on the Repositories page, or answer with another repository.",
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

  it("leaves the run context empty for the duplicate proposal, which is about no repository", () => {
    // A model that proposed the same repository twice broke the protocol. It is
    // not a question about a repository, it records nothing, and turning it into
    // one would write a decision nobody made.
    const { decision, ask } = discover({
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

    expect(decision.reason).toBe("Repository discovery returned duplicate repositories.");
    expect(ask).toBeUndefined();
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
    " or with the repositories this ticket should use instead.";

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
  ])("asks again when a person quotes one sentence of our question and writes %s", (_what, said) => {
    expect(read([`> ${oneSentenceOfTheQuestion()}`, said].join("\n"))).toEqual({
      kind: "unrecognised",
    });
  });

  it("asks again when a person quotes the whole question and writes none under it", () => {
    expect(read([`> ${postedQuestion()}`, "none"].join("\n"))).toEqual({ kind: "unrecognised" });
  });

  it("reads our own question sent back after a keyboard turned the quotes curly as no answer at all", () => {
    // The question embeds the model's words in straight double quotes, and a
    // phone keyboard or an editor substitutes typographic ones. Matched
    // literally, the copy is no longer ours, and this answer, which is nothing
    // but our question, was read as the person naming the repository in it.
    expect(read(`> ${withCurlyQuotes(postedQuestion())}`)).toEqual({ kind: "unrecognised" });
  });

  it("asks again when a person writes none under a quote a keyboard turned curly", () => {
    expect(read([`> ${withCurlyQuotes(postedQuestion())}`, "none"].join("\n"))).toEqual({
      kind: "unrecognised",
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
   * one. Each of these named two repositories and rejected one of them, and
   * the rejected one was recorded as selected beside the other, so the
   * exclusion was reversed by the very sentence that upheld it. The words are
   * read around the names, never inside them, so "acme/no-code" is still a
   * repository and not a refusal.
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
    "pomin acme/api, uzyj acme/web",
    "usun acme/api, uzyj acme/web",
  ])("keeps only the repository a person redirected us to when they wrote %s", (said) => {
    expect(read(said)).toEqual({
      kind: "repositories",
      repositoryKeys: ["github:acme/web"],
    });
  });

  it("keeps the redirection when a person wrote it under our posted question", () => {
    // Both defences on one answer: our words come out, and what is left says
    // no to the repository it names beside the one they chose.
    const answer = [postedQuestion(), "Ada Lovelace: use acme/web instead of acme/api"].join("\n");

    expect(read(answer)).toEqual({
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
