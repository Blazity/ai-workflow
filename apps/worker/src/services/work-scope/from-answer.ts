/**
 * A person's answer to a repository question, as an entry in the record.
 *
 * The clarification channels own delivering an answer and waking the run that
 * asked; what those words decide about which repositories a subject's work may
 * touch is this cluster's business, and it is decided here, once, where the
 * answer arrives.
 */
import {
  repositoryCatalogKey,
  type RepositoryKey,
  type WorkScope,
  type WorkScopeAnswerReading,
  type WorkScopeAskedRepository,
  type WorkScopeEntry,
  type WorkScopeQuestionAnswer,
  type WorkScopeWritePlan,
} from "@shared/contracts";
import type { HookClarificationRow } from "../../db/repositories/clarification-hooks.js";
import {
  hasNoWords,
  parseRepositoryExpansionAnswer,
  refusalNamesRepositories,
} from "../../engine/repository-discovery/runner.js";
import type { AnswerNotRecordedReason } from "../../engine/support/clarification-comment-format.js";
import {
  answerCountsAgainstTheList,
  answerNamesKeptRepositories,
  answerSaysNoAndNamesARepository,
  readRepositoryAnswer,
  withoutQuotedText,
} from "../../engine/work-scope/answer.js";
import { questionShowedKeptRepositories } from "../../engine/work-scope/context.js";
import {
  decideWorkScope,
  isDecidedByAPerson,
  isHeldSelection,
  repositoriesADelegationTakes,
} from "../../engine/work-scope/decide.js";
import { logger } from "../../infra/logger.js";

/** What recording an answer needs of the tier that owns the database, and
 *  nothing else. */
export interface RepositoryAnswerPersistence {
  /** Every catalog key and the enabled half of it. An answer is read against
   *  every key, enabled or not, because a person naming back the repository
   *  they were asked about must be understood even while the catalog refuses
   *  it. */
  repositoryCatalog(): Promise<{
    activated: boolean;
    keys: RepositoryKey[];
    enabledKeys: RepositoryKey[];
  }>;
  readWorkScope(subjectKey: string): Promise<WorkScope | null>;
  applyAnswerWorkScope(input: {
    subjectKey: string;
    runId: string;
    clarificationId: string;
    plan: WorkScopeWritePlan;
  }): Promise<{ outcome: "applied"; version: number } | { outcome: "already_applied" }>;
}

/** How the Jira comment path composes an answer: each qualifying comment as
 *  "<author>: <body>", joined with a blank line
 *  (`services/clarifications/resume-from-comments.ts:346-347`). The space after
 *  the colon is what keeps "github:acme/web" from reading as an author. The
 *  expansion protocol's refusal reader knows the same two shapes
 *  (`COMMENT_SEPARATOR` and `COMMENT_AUTHOR_PREFIX`,
 *  `engine/repository-discovery/runner.ts:1470-1471`), where it asks a
 *  different question of them: whether every part is a refusal, trying each
 *  part with the prefix and without it, so it never drops a byte either way. */
const COMPOSED_COMMENT_SEPARATOR = "\n\n";
const COMPOSED_AUTHOR_PREFIX = /^[^:\n]+: /;

/** How many repositories one answer may record at once: the contract's bound
 *  on an answer (`workScopeQuestionAnswerSchema`) and the decision's bound on
 *  one event. A name that resolves past it is told, never dropped in silence
 *  and never allowed to throw the whole answer away. */
const ANSWER_REPOSITORIES_MAX = 8;

/**
 * The answer with the composed author taken off the front of each comment, and
 * every other byte kept: what the person wrote is the answer. Without this a
 * bare reply of "api, web" arrives as "Filip Maszota: api, web" and names
 * nobody the reader knows.
 *
 * Per comment, never per paragraph. A blank line is a paragraph break inside
 * one Jira comment at least as often as it is the join between two of them, so
 * stripping a prefix from every piece eats the start of a paragraph: "Ada:
 * Sure.\n\nacme/api: that is the backend" loses the half that names the
 * repository, and the person is asked again about a repository they just named.
 *
 * What tells a comment from a paragraph is the author, and here the author is
 * known: the record only ever decides from an answer no more than one person
 * wrote (the guard in `recordRepositoryAnswer` declines the rest), so every
 * comment in it opens with the SAME name. Taking that name from the front of the
 * answer gives the exact prefix each of this person's comments carries, and a
 * paragraph of their own cannot match it unless they wrote their own name in
 * front of it. The model reads an answer before its authors are counted, so it
 * can be handed one several people wrote; there the first author's line comes
 * off and a second author's stays, and the record declines those words anyway.
 */
function withoutComposedAuthors(answer: string): string {
  const [author] = COMPOSED_AUTHOR_PREFIX.exec(answer) ?? [];
  if (author === undefined) return answer;
  return answer
    .split(COMPOSED_COMMENT_SEPARATOR)
    .map((comment) => (comment.startsWith(author) ? comment.slice(author.length) : comment))
    .join(COMPOSED_COMMENT_SEPARATOR);
}

/**
 * WHAT THIS PERSON WROTE, which is what every reader of an answer is handed: the
 * model that reads it where it arrives and the record that decides from it. One
 * rule for both, because two readers handed two different texts reach two
 * different conclusions about one reply.
 *
 * The composed author line comes off ONLY where an author line was composed. On
 * the ticket it is not the person's words: handed to the model, "Filip
 * Maszota: <reply>" was paraphrased back to Filip as a reply that referenced
 * Filip Maszota, and a display name like "Demo Team" puts a word in front of the
 * reader that points at a repository nobody chose.
 *
 * The strip used to run on every answer, and on the two channels that compose
 * nothing it ate the start of the person's own sentence: the prefix is
 * "anything, then a colon and a space", which is also how somebody writes
 * "acme/api: this is the one" into the dashboard box or sends it through MCP.
 * That reply lost the only repository it named and was answered with "nothing
 * in that answer named a repository", while the identical words on a ticket
 * attached it. The other direction is worse and is why this is a defect rather
 * than a nuisance: "api: none" became a bare "none" and declined every
 * repository the question listed, which is a decision fabricated out of a
 * person's words (A18).
 *
 * The words the channel delivered stay as they arrived everywhere else: stored
 * on the row, compared against the next delivery, and redelivered on a retry.
 * Only what is READ changes.
 */
export function answerAsWritten(
  answer: string,
  channel: { composedFromComments: boolean },
): string {
  return channel.composedFromComments ? withoutComposedAuthors(answer) : answer;
}

/**
 * What one answer did to the record, for the channel that took it.
 *
 * Both halves are for a person, and they are mutually exclusive: an answer
 * either left no repository decision behind it, which is `told`, or it was read
 * as a decline and wrote one entry per repository the question listed, which is
 * `declined`. The caller turns either into the sentence a person reads; nothing
 * else in a run branches on this.
 */
export interface RepositoryAnswerOutcome {
  /** Why this answer recorded nothing, absent when it recorded something. */
  told?: AnswerNotRecordedReason;
  /** The repositories a decline left out of this work, in the order the plan
   *  wrote them. Absent unless the answer was read as a refusal. */
  declined?: RepositoryKey[];
  /** The repositories the question listed that an answer NAMING others left
   *  out. The same binding as a decline, and it was the silent half of it:
   *  nobody was told. Absent unless the answer named repositories and the
   *  question listed more than it. */
  leftOut?: RepositoryKey[];
  /**
   * What the workflow chose when the person handed the decision back, and what
   * the question listed that it did not choose. Nothing binds the second list:
   * the person judged none of it (see `repositoriesADelegationTakes`). A
   * repository a person had already decided on is in neither. Absent unless
   * the answer was a delegation.
   */
  delegated?: { taken: RepositoryKey[]; notTaken: RepositoryKey[] };
  /**
   * The repositories the answer named that the question never listed, as the
   * catalog resolved them: `added` are enabled and now selected as this
   * person's choice, `notEnabled` are held but not enabled and are selected as
   * their choice all the same (the run refuses them at start, A5), `unmatched`
   * resolved to nothing and recorded nothing, and `overLimit` resolved but did
   * not fit in one answer. Absent unless the answer named repositories and the
   * reading carried a name the question never offered.
   */
  alsoNamed?: {
    added: RepositoryKey[];
    notEnabled: RepositoryKey[];
    unmatched: string[];
    overLimit: RepositoryKey[];
  };
}

/** What an answer we decline to attribute is handed to the decision as, which
 *  leaves the trail row saying an answer arrived and writes no entry. Its own
 *  kind, rather than the one that means we could not read the words: the words
 *  here may be perfectly clear, and what is missing is whose they are. */
const DECLINED_ANSWER: WorkScopeQuestionAnswer = { kind: "unattributed" };

/**
 * What a refusal that never says what it is refusing is handed to the decision
 * as, when it arrived as a comment on a ticket.
 *
 * "unrecognised" rather than a kind of its own: it is what the decision already
 * does with words it will not act on, it writes the trail row and no entry, and
 * the sentence explaining this particular case goes where a person can read it,
 * on the ticket. "unattributed" would be a lie in the other direction, because
 * we know perfectly well who wrote this one.
 */
const UNADDRESSED_REFUSAL_ANSWER: WorkScopeQuestionAnswer = { kind: "unrecognised" };

/**
 * The stored reading as the decision vocabulary the record writes in.
 *
 * Two of the four outcomes collapse here and they are right to: `declined_all`
 * and `declined_one` are the same fact to a record that already knows what the
 * question listed, namely that this person refused what they were shown. They
 * are separate in the reading because only the question's shape can tell them
 * apart, and telling them apart is what stops "continue without it" refusing
 * four repositories.
 *
 * `unclear` maps to unrecognised for the legacy path's sake only. A question
 * that carries a reading never gets here with one: the channel that took the
 * answer parks the question and tells the person instead of recording anything.
 */
function questionAnswerOfReading(
  reading: WorkScopeAnswerReading,
  asked: readonly WorkScopeAskedRepository[],
  entries: readonly WorkScopeEntry[],
): WorkScopeQuestionAnswer {
  switch (reading.outcome.kind) {
    case "repositories":
      return { kind: "repositories", repositoryKeys: reading.outcome.repositoryKeys };
    case "declined_all":
    case "declined_one":
      return { kind: "none" };
    // Which repositories a delegation takes is decided HERE, by our rule over
    // what the question listed, and never by the reader: the reading says only
    // that the person handed the choice back.
    case "delegated":
      return { kind: "delegated", repositoryKeys: repositoriesADelegationTakes(asked, entries) };
    case "unclear":
      return { kind: "unrecognised" };
  }
}

/**
 * The names an answer pointed at that the question never offered, looked up in
 * the catalog this answer path already loaded.
 *
 * THE MODEL NEVER CHOOSES THESE. It copies a name out of the reply and that is
 * all; whether the name is a repository is this function's question, answered
 * against the deployment's own catalog, so an invented key resolves to nothing
 * and records nothing. The rule is the one the deterministic reader and the
 * "no such repository" sentence already use: a path written out, provider
 * scoped or an owner/name that is unique across providers. A bare short name is
 * not resolved (A3), because "web" is a word before it is a repository.
 */
function resolveUnofferedNames(
  names: readonly string[],
  catalogKeys: readonly RepositoryKey[],
): { held: RepositoryKey[]; unmatched: string[] } {
  const held: RepositoryKey[] = [];
  const unmatched: string[] = [];
  for (const name of names) {
    const identities = parseRepositoryExpansionAnswer(name);
    const identity = identities.length === 1 ? identities[0] : undefined;
    let key: RepositoryKey | undefined;
    if (identity?.provider) {
      const candidate = repositoryCatalogKey({ provider: identity.provider, path: identity.repoPath });
      if (catalogKeys.includes(candidate)) key = candidate;
    } else if (identity) {
      const path = identity.repoPath.toLowerCase();
      const matches = catalogKeys.filter((candidate) => candidate.slice(candidate.indexOf(":") + 1) === path);
      if (matches.length === 1) key = matches[0];
    }
    if (key === undefined) unmatched.push(name);
    else if (!held.includes(key)) held.push(key);
  }
  return { held, unmatched };
}

/**
 * Write what the answer decided, with the authorship already established.
 *
 * Separate from the counting above because the two happen at different moments
 * in a delivery: counting decides whether this delivery may go ahead at all, and
 * must cost nothing when it cannot; writing is a side effect, and belongs where
 * every other side effect of a committed delivery is, behind the reservation
 * that proves this delivery is the one going ahead.
 */
export async function recordRepositoryAnswer(
  persistence: RepositoryAnswerPersistence,
  input: {
    row: HookClarificationRow;
    answer: string;
    answeredAt: Date;
    answerer: { id: string; label: string };
    /** Whether these words were composed out of a ticket's comments, which is
     *  the one channel the refusal guard below narrows to. Stated by the
     *  clarification tier, which owns how an answer reaches us, rather than
     *  worked out again here from the shape of an actor id. */
    composedFromComments: boolean;
    authorCount?: number;
  },
): Promise<RepositoryAnswerOutcome> {
  const askedRepositories = input.row.askedRepositories ?? [];
  const authorCount = input.authorCount;
  // WHAT THIS PERSON WROTE, by the same rule the model was handed it
  // (`answerAsWritten`).
  const theirAnswer = answerAsWritten(input.answer, {
    composedFromComments: input.composedFromComments,
  });

  // Words several people wrote together decide nothing (A50). The ticket
  // channel composes its answer out of every comment posted after the
  // question, whether or not anybody was answering, so a colleague's aside
  // arrives inside the answer with nothing marking it apart. Read as one
  // person's decision it writes two entries nobody can undo: the repository
  // the aside happened to name, selected in their name, and the repository we
  // asked about, refused for not having been named. The run resumes on the
  // same words either way; only the entries are declined, so the next run asks
  // again. A repeated question is a cost, a fabricated decision is a defect.
  //
  // The count is a number from the comments themselves. It is never recovered
  // from the answer, because the answer does not say: a person whose own line
  // opens "reason:" is still one person, and a display name carrying a colon is
  // still one author.
  //
  // A warning rather than a note, because anything commenting after our
  // question counts as a second author: one Jira automation rule firing on the
  // move into the AI column would decline every answer on every ticket, and the
  // only symptom anybody sees is the question being asked twice.
  const declined = authorCount !== undefined && authorCount > 1;
  if (declined) {
    logger.warn(
      {
        runId: input.row.runId,
        clarificationId: input.row.id,
        authorCount,
      },
      "work_scope_answer_not_attributed_multiple_authors",
    );
  }
  const catalog = await persistence.repositoryCatalog();
  const askedKeys = askedRepositories.map((repository) => repository.repositoryKey);
  // What counts as a repository this deployment has: the catalog, plus whatever
  // the question itself named, because a question naming a key the catalog has
  // since dropped is still this deployment asking about it. One list, read by
  // the reader below and by the sentence at the end, so the two cannot disagree
  // about which names we hold.
  const catalogKeys = [...new Set([...catalog.keys, ...askedKeys])];
  // There is no branch here for a subject that could not be found, and none is
  // missing. The clarification row names the subject the question was asked
  // under, and a row without one cannot be read at all
  // (`db/repositories/clarification-hooks.ts:33` refuses it), so the key below
  // always exists. A subject with no row in `work_scopes` is not a subject
  // nobody can name either: it is one nobody has decided anything about yet,
  // and this answer is the first decision, which is what creates the record. A
  // gate on that emptiness would drop exactly the first answer on a ticket,
  // which is the answer this function exists to keep.
  const scope = await persistence.readWorkScope(input.row.subjectKey);
  // What the question showed as already part of this work, read from the
  // record rather than out of the question's words: what it showed is what the
  // record holds for a reason an answer does not undo (`isHeldSelection`, the
  // same predicate the question was built with). Read at the answer, so a
  // repository taken off the work in between is no longer kept, and one added
  // in between is treated as shown: the cost of that is a repeated question,
  // never a decision.
  //
  // READ FROM THE QUESTION THAT SHOWED THEM, not from the reason it was asked.
  // Repository discovery stamps `selection` on its asks too, and its question
  // lists no kept repositories at all, so keying on the reason told a person
  // their answer had been about repositories nobody had put in front of them.
  // One builder writes that sentence, so its presence is the fact
  // (`questionShowedKeptRepositories`).
  const keptKeys =
    askedRepositories.length > 0 &&
    askedRepositories.every((repository) => repository.askedBecause === "selection") &&
    questionShowedKeptRepositories(input.row.questions)
      ? (scope?.entries ?? [])
          .filter(isHeldSelection)
          .map((entry) => entry.repositoryKey)
          .filter((key) => !askedKeys.includes(key))
      : [];
  // What we asked is the only part of this exchange we know for certain, and
  // the reader needs it: Jira's quote button sends our own question back inside
  // the answer with no marker on it, and the repository key in it is ours, not
  // the person's.
  const reading = { catalogKeys, askedQuestions: input.row.questions, keptKeys };
  // A declined answer is not read at all, which is the point: the words may be
  // perfectly readable, they are simply not one person's decision to record.
  // THE READING THE ANSWER ARRIVED WITH, when it has one.
  //
  // It was made once, by a model, where the answer landed, against the question
  // as the person saw it, and it is stored on the row beside their words
  // (`services/work-scope/read-answer.ts`). Reading the sentence again here
  // with a different set of rules is what made the record and the run disagree
  // about one reply: "yes" to a question about one repository was a selection
  // to the parser below and noise to the run's, so the record held a decision
  // the run then ignored.
  //
  // Absent on two kinds of row and the old reader still serves both: a question
  // that named no repository, where there is no closed set to read an answer
  // into, and a row answered before the reading existed.
  const stored = input.row.answerReading;
  const readAnswer = declined
    ? DECLINED_ANSWER
    : stored
      ? questionAnswerOfReading(stored, askedRepositories, scope?.entries ?? [])
      : readRepositoryAnswer(theirAnswer, { ...reading, askedKeys });

  // A REPOSITORY THEY NAMED THAT THE QUESTION DID NOT LIST IS TAKEN WHEN THIS
  // DEPLOYMENT HOLDS IT (AWP-221: "demo please, and github:Blazity/ai-workflow as
  // well" recorded demo and told them the other was not acted on).
  //
  // THE BOUND MOVES, and this is where. It used to be the keys the question put
  // in front of the person, which is the argument A19c made for safety. It is
  // now the repositories this deployment's catalog holds, and three guards
  // keep that acceptable, each of them enforced before this line: the name
  // comes only from a person's ANSWER (the reading of the words they delivered,
  // never the ticket's own text), the ticket channel reads no comment our own
  // bot account wrote as an answer, and an answer several people wrote is
  // `DECLINED_ANSWER` above and never reaches the branch below. An invented or
  // injected key still resolves to nothing, so the worst an instruction hidden
  // in a reply can reach is a repository this deployment already holds, named
  // back to the person in the note they get.
  //
  // Only where the answer CHOSE repositories. A refusal or a delegation beside a
  // name is a reply the reader was told to read as a selection instead (naming
  // beats refusing and delegating), so a name surviving beside one is an aside,
  // and it is told back exactly as before rather than acted on.
  //
  // Enabled or not, it is recorded as THEIR choice (A5): the run refuses one it
  // cannot use at start and says why, and once somebody enables it the next run
  // takes it without asking again. Writing it `unavailable` in their name would
  // record a refusal nobody made.
  const unofferedNames = stored?.unofferedNames ?? [];
  let alsoNamed: RepositoryAnswerOutcome["alsoNamed"];
  let answerRead = readAnswer;
  if (readAnswer.kind === "repositories" && unofferedNames.length > 0) {
    const { held, unmatched } = resolveUnofferedNames(unofferedNames, catalog.keys);
    // What the reading already decided about stays decided: a key the question
    // offered, or one it showed as kept, is not the reading's to widen.
    const outside = held.filter(
      (key) => !askedKeys.includes(key) && !keptKeys.includes(key),
    );
    const room = Math.max(0, ANSWER_REPOSITORIES_MAX - readAnswer.repositoryKeys.length);
    const taken = outside.filter((key) => !readAnswer.repositoryKeys.includes(key)).slice(0, room);
    const overLimit = outside.filter(
      (key) => !readAnswer.repositoryKeys.includes(key) && !taken.includes(key),
    );
    if (overLimit.length > 0) {
      logger.warn(
        { runId: input.row.runId, clarificationId: input.row.id, overLimit },
        "work_scope_answer_named_more_than_one_answer_records",
      );
    }
    answerRead = { kind: "repositories", repositoryKeys: [...readAnswer.repositoryKeys, ...taken] };
    alsoNamed = {
      added: taken.filter((key) => catalog.enabledKeys.includes(key)),
      notEnabled: taken.filter((key) => !catalog.enabledKeys.includes(key)),
      unmatched,
      overLimit,
    };
  }

  // A PLAIN NO ON A TICKET IS NOT EVIDENCE THAT ANYBODY ANSWERED US.
  //
  // What a refusal writes is the heaviest thing in this feature: every
  // repository the question named, left out in that person's name, and an
  // exclusion never expires. What it rests on, when it arrives through the
  // ticket, is a comment posted in a window. Nothing threads it to our
  // question. A colleague replying "no" to the comment above ours, or a Jira
  // rule configured to comment as a named user, is read as that person
  // declining every repository we asked about, and nobody typed a word about
  // repositories.
  //
  // So the evidence has to match the weight. A refusal that says what it
  // refuses ("none of these", "no more repositories", "continue without it")
  // could not be about anything else, and is recorded exactly as before. A bare
  // "no" is recorded as nothing, the person is told why in a comment that says
  // what to write instead, and the question comes again. That is the ordering
  // this feature is built on: a repeated question is a cost, a decision nobody
  // made is a defect (A34).
  //
  // Which phrases reach which way is decided where the phrases are declared
  // (`REFUSAL_ANSWERS` in `engine/repository-discovery/runner.ts`), and read
  // here rather than worked out again. There is only one list, and the type of
  // its values is what stops a new phrase joining it undecided.
  //
  // Narrow on purpose, in three ways. Only the ticket channel, because the
  // dashboard and the MCP client type into a box opened by this question and a
  // "no" there is unmistakably an answer to it. Only a question that put
  // repositories in front of somebody, because a refusal to any other decides
  // nothing to begin with (`decideAnswered` writes nothing for an asked
  // repository the question did not name, and the answered set leaves it out).
  // A `selection` question is inside that line, not outside it: its refusal
  // writes no entry, but it settles every repository the question named for
  // good, through the answered set (`isUnnamedInAnswer`), and it raises the
  // subject's selection flag, which is as permanent as an exclusion and signed
  // by the same person (A8). And only a refusal: an answer naming
  // repositories is its own evidence, since nobody types a repository path by
  // accident.
  //
  // WHAT A READING CANNOT SETTLE IS WHETHER THESE WORDS WERE ADDRESSED TO US,
  // and that is what this check is really about. It is not a second opinion on
  // the reading: a reading answers "what do these words mean", and a comment on
  // a ticket raises a prior question, "was this person talking to us at all".
  // Nothing threads a comment to our question, so a colleague answering the
  // comment above ours is indistinguishable from an answer, and the write at
  // stake is permanent.
  //
  // NARROWED TO THE ONE SHAPE WHERE THAT DOUBT IS REAL. A reading of
  // `declined_all` came from words that say they refuse the list ("none of
  // these", "No. None of these."), and words like those could not be about
  // anything else; a bare no under a list never gets here at all, because it is
  // unclear and the channel keeps the question open. What is left is
  // `declined_one`, where the whole reply can be the single word "no", and that
  // one still has to say what it refuses before it writes an exclusion.
  const refusalDecidesNothing =
    (!stored || stored.outcome.kind === "declined_one") &&
    answerRead.kind === "none" &&
    input.composedFromComments &&
    askedRepositories.some((repository) => repository.named === true) &&
    // Their own words, quotes out (A6). A person who clicks quote on our
    // question and writes "none of these" underneath used the exact phrase the
    // question teaches, and reading the quote too made that answer look like a
    // bare no addressed to nothing, so they were told it decided nothing.
    // The count is the same one the counting-word rule reads, because it is the
    // same fact: what the question put in front of this person. A phrase naming
    // ONE repository says what it refuses under a question that asked about one,
    // and contradicts a question that listed four, where the reader has already
    // recorded nothing.
    !refusalNamesRepositories(
      withoutQuotedText(theirAnswer, input.row.questions),
      askedKeys.length,
    );
  if (refusalDecidesNothing) {
    // A warning, for the same reason the declined count is one: from the
    // outside this looks exactly like the question being asked twice.
    logger.warn(
      { runId: input.row.runId, clarificationId: input.row.id },
      "work_scope_answer_refusal_not_addressed",
    );
  }
  const answer = refusalDecidesNothing ? UNADDRESSED_REFUSAL_ANSWER : answerRead;
  const decision = decideWorkScope(
    {
      scope,
      carriesRecord: true,
      // Enabled is all this path can see: it holds no provider listing, so it
      // cannot tell enabled from usable and says so by passing no unusable
      // keys (A26).
      //
      // SO AN ENTRY WRITTEN HERE MAY NAME A REPOSITORY THIS DEPLOYMENT CANNOT
      // REACH. Null means this path never listed the repositories rather than
      // that it listed them and found them all usable (`engine/work-scope/
      // context.ts`), and getting a listing would turn answering a question
      // into a provider API call. It is the reader that keeps such a key from
      // doing harm: a person-origin selection only closes the matter when the
      // run can actually reach it (`decideTextAmbiguous` in
      // `engine/work-scope/decide.ts`), so an unreachable one is recorded, the
      // run refuses it, the question is still asked, and the person can
      // correct it. The entry is a person's decision either way, and deleting
      // it because today's deployment cannot act on it would be us overruling
      // them.
      catalog: {
        activated: catalog.activated,
        enabledKeys: catalog.enabledKeys,
        unusableKeys: null,
      },
      // The definition pin, the trigger policy, the workspace and the selection
      // flag each bound what a RUN may do with repositories. A person's answer
      // is bounded by none of them, and an `answered` event reads none of them.
      pinnedProviders: null,
      pinnedKeys: null,
      policy: null,
      eventRelatedKeys: [],
      attachedKeys: null,
      selectionAnswered: false,
      // An answer decides no guess, so what earlier answers left unnamed is
      // nothing this event reads, and neither is the ticket text that a later
      // run dates against them.
      answeredRepositoryKeys: [],
      postAnswerMentionedKeys: [],
      actor: {
        kind: "person",
        actorId: input.answerer.id,
        actorLabel: input.answerer.label,
      },
      now: input.answeredAt.toISOString(),
    },
    { kind: "answered", clarificationId: input.row.id, asked: askedRepositories, answer },
  );
  // Not caught. A swallowed write is the lost answer this record exists to
  // prevent, wearing a smile: the caller reports the failure, the channel
  // delivers the same answer again, and the answer-once index applies it once.
  await persistence.applyAnswerWorkScope({
    subjectKey: input.row.subjectKey,
    runId: input.row.runId,
    clarificationId: input.row.id,
    plan: decision.plan,
  });
  if (refusalDecidesNothing) return { told: "unaddressed_refusal" };

  // A DELEGATION IS A DECISION, SO NONE OF THE "RECORDED NOTHING" SENTENCES
  // BELOW IS TRUE OF IT, not even when it took nothing: a question about a
  // repository the run cannot use, handed back, is answered by continuing
  // without it. What the person hears is what the workflow chose and what it
  // left open, from the same rule that wrote the entries.
  //
  // A repository a person had already decided on is in neither list: the
  // workflow did not choose it, and "nothing is recorded about it" would be
  // false, because their own entry is.
  if (answer.kind === "delegated") {
    return {
      delegated: {
        taken: answer.repositoryKeys,
        notTaken: [
          ...new Set(
            askedRepositories
              .filter(
                (repository) =>
                  repository.named === true &&
                  !answer.repositoryKeys.includes(repository.repositoryKey) &&
                  !keptKeys.includes(repository.repositoryKey) &&
                  !isDecidedByAPerson(scope?.entries ?? [], repository.repositoryKey),
              )
              .map((repository) => repository.repositoryKey),
          ),
        ],
      },
    };
  }
  const withAlsoNamed = (outcome: RepositoryAnswerOutcome): RepositoryAnswerOutcome =>
    alsoNamed ? { ...outcome, alsoNamed } : outcome;

  // NOBODY IS ASKED SOMETHING THEY HAVE ALREADY ANSWERED WITHOUT BEING TOLD WHY.
  //
  // An answer can be read, be nobody's fault, and still leave the record exactly
  // as it found it: a "no" to "which repository should this ticket modify?"
  // names nothing, and a question that listed no repository has nothing to
  // record a refusal against either. The run resumes, finds nothing selected,
  // and puts the same question again. Without a sentence here the person sees
  // their answer vanish and the question return, over and over, until the
  // delivery attempts run out, which is the loop this feature exists to end.
  //
  // What silences a repository question is not a guess about the future: it is
  // one of exactly two reads over the trail this answer just wrote
  // (`db/repositories/work-scope.ts`). Both of them count only an answer the
  // reader resolved to a decision, because both require the recorded answer
  // kind to be `none` or `repositories` and take no other.
  // `readWorkScopeSelectionAnswered` raises a permanent flag for the subject
  // once such an answer reaches a `selection` question, so that question is
  // settled from then on whatever it recorded, and saying otherwise would name
  // a fault that is not there. An `unrecognised` or an `unattributed` answer
  // raises nothing, because nobody decided anything: the flag stays down, the
  // next run puts the same question again, and the person who answered is owed
  // the reason. That is the case this sentence exists for, and suppressing it
  // because a `selection` question was answered AT ALL would hide exactly the
  // loop this feature was built to end.
  // The kind is read off the answer written into the trail above rather than
  // guessed from the question, so the two cannot drift apart: the question is
  // settled here on the same fact the statement settles it on there.
  // `readWorkScopeAnsweredRepositories` suppresses the repositories a question
  // NAMED once it has an answer, and a question that named none suppresses
  // nothing. So an empty-handed plan that settled nothing means the question is
  // coming back. The sentence says MAY come back rather than WILL, which keeps
  // it true in the one case this cannot see: a key whose entry the origin
  // ladder refused is suppressed all the same.
  const recordKeptNothing = decision.plan.upserts.length === 0 && decision.plan.deletes.length === 0;
  const settledByAnsweringAtAll =
    (answer.kind === "none" || answer.kind === "repositories") &&
    askedRepositories.some((repository) => repository.askedBecause === "selection");
  // WHAT A DECLINE RECORDED, for the person who typed it. A bare "no" on the
  // dashboard or over MCP declines every repository the question listed, and
  // until now those channels said nothing at all about it: the screen showed
  // "answered" and the rule lived in a tool description no human reads.
  //
  // Read off the ASK rather than off the plan's entries, because the entry is
  // not what the person needs told. A `selection` question writes no entry for
  // a name left out (rule 5, `decideAnswered`) and binds it all the same
  // through the answered set, so a list built from the upserts would be silent
  // about exactly the question this feature exists for. `named` is the same
  // condition the writer uses: a repository nobody was shown the name of was
  // not declined by anybody.
  const declinedKeys =
    answer.kind === "none"
      ? [
          ...new Set(
            askedRepositories
              .filter((repository) => repository.named === true)
              .map((repository) => repository.repositoryKey),
          ),
        ]
      : [];
  // Before the two branches below, not inside one of them. A decline is a
  // decision, so it is never also a reason the record kept nothing, and putting
  // it after a branch that can return would make whether the person hears it
  // depend on which kind of question they answered.
  if (declinedKeys.length > 0) return withAlsoNamed({ declined: declinedKeys });
  // AND WHAT AN ANSWER THAT NAMED SOMETHING LEFT OUT, which binds exactly as a
  // decline does and said nothing to anybody. The question listed four, the
  // person named one, and the other three are out of this work with no later
  // run taking them (C11); the bare "no" beside it got a full sentence and the
  // considered answer got silence. Read off the ASK for the reason the decline
  // is: a `selection` question writes no entry for a name left out and binds it
  // through the answered set, so the entries cannot say this.
  const leftOutKeys =
    answer.kind === "repositories"
      ? [
          ...new Set(
            askedRepositories
              .filter(
                (repository) =>
                  repository.named === true &&
                  !answer.repositoryKeys.includes(repository.repositoryKey) &&
                  !keptKeys.includes(repository.repositoryKey),
              )
              .map((repository) => repository.repositoryKey),
          ),
        ]
      : [];
  if (leftOutKeys.length > 0) return withAlsoNamed({ leftOut: leftOutKeys });
  if (!recordKeptNothing || settledByAnsweringAtAll) return withAlsoNamed({});
  // An answer with no word in it is its own case, because the RUN does
  // something with it that nothing else here does: `isRefusalAnswer` takes the
  // wordless branch and ends the asking, so the run carries on without the
  // repository it asked about while the record writes nothing. Asked of the
  // stored answer exactly as the run reads it, prefixes and all, so the two
  // never disagree about which branch was taken. A thumbs up posted as a Jira
  // comment arrives here as "Jane: (thumbs up)", which HAS words, and the run
  // asks its follow-up instead; that one is told the ordinary sentence, which
  // is the truthful one for it.
  if (hasNoWords(input.answer)) return withAlsoNamed({ told: "no_words" });
  // Two unreadable replies the ordinary sentence would describe falsely, since
  // "nothing in that answer named a repository this work should use" is not
  // true of "this one, but not that one". A reply about a repository the
  // question said stays gets where that repository leaves instead, and a reply
  // that names a repository beside a no it could not be tied to is told why
  // it was not read as a choice.
  if (answer.kind === "unrecognised") {
    if (answerNamesKeptRepositories(theirAnswer, reading)) {
      return withAlsoNamed({ told: "names_kept_repository" });
    }
    if (answerSaysNoAndNamesARepository(theirAnswer, reading)) {
      return withAlsoNamed({ told: "refusal_beside_named" });
    }
    // "both" under a question that listed three. The reply is not ambiguous and
    // it names nothing: it contradicts the list in front of it, so the reader
    // records nothing (A11l). Told as its own reason, because the ordinary
    // sentence says nothing in the answer named a repository, which is silent
    // about the count and leaves the same word as the obvious second attempt.
    if (
      answerCountsAgainstTheList(theirAnswer, {
        askedQuestions: input.row.questions,
        askedCount: askedKeys.length,
      })
    ) {
      return withAlsoNamed({ told: "counting_word_and_list_disagree" });
    }
  }
  // WHICH OF THE TWO WAYS AN ANSWER NAMES NOTHING. Both end here with an empty
  // record, and only one of them leaves "write the full path in a comment" true.
  // A person who wrote a bare or partial name can write it out in full and the
  // next run resolves it; a person who already wrote `github:acme/thing` in
  // full, for a repository this deployment does not hold, would write the same
  // words for the next run to resolve to the same nothing.
  return withAlsoNamed({
    told: namedOnlyRepositoriesWeDoNotHold({
      answer: theirAnswer,
      askedQuestions: input.row.questions,
      catalogKeys,
    })
      ? "no_such_repository"
      : "no_repository_named",
  });
}

/**
 * True when everything the person spelled out as a repository path names
 * something this deployment has no record of at all.
 *
 * ASKED HERE RATHER THAN READ OFF THE ANSWER, and deliberately so: the reader
 * collapses both cases into `unrecognised`, because for the RECORD they are the
 * same fact (nothing to write). They differ only in what is true to tell
 * somebody, which is this function's caller's question. Widening the reader's
 * verdict would change a contract two lanes read, at freeze time, to serve one
 * sentence.
 *
 * A PREDICATE, NOT A THIRD RESOLVER. It asks whether the catalog holds anything
 * by that name, not which key it resolves to, so it cannot disagree with
 * `resolveIdentity` in a way that matters: a bare path present on two providers
 * is ambiguous there and held here, and held is the right answer for the
 * sentence, because writing that one provider-scoped does resolve.
 *
 * No identity at all means prose or a bare word, which is the case the ordinary
 * sentence is written for. One answer carrying both shapes gets this one, which
 * is the fuller explanation and still true for them.
 */
function namedOnlyRepositoriesWeDoNotHold(input: {
  answer: string;
  askedQuestions: string[];
  catalogKeys: RepositoryKey[];
}): boolean {
  // Our own question quoted back is not the person naming anything, and neither
  // is any other quoted line: this is the same drop the reader makes before it
  // reads a word, so a path sitting inside a quote cannot produce the sentence
  // saying this deployment has no repository by that name (A7).
  const identities = parseRepositoryExpansionAnswer(
    withoutQuotedText(input.answer, input.askedQuestions),
  );
  if (identities.length === 0) return false;
  const held = new Set(input.catalogKeys);
  const heldPaths = new Set(input.catalogKeys.map((key) => key.slice(key.indexOf(":") + 1)));
  return identities.every((identity) =>
    identity.provider
      ? !held.has(repositoryCatalogKey({ provider: identity.provider, path: identity.repoPath }))
      : !heldPaths.has(identity.repoPath.toLowerCase()),
  );
}
