/**
 * Who wrote an answer, and how many people that was.
 *
 * One question, asked of every channel the same way: the delivery that composes
 * an answer out of ticket comments reads these helpers as it composes, and the
 * record that judges a stored answer later counts it again from the same
 * comments through `readAnswerAuthorship`, so no two readers of one ticket can
 * reach two answers.
 */
import {
  type IssueTrackerAdapter,
  type TicketComment,
  type TicketContent,
} from "../../adapters/issue-tracker/types.js";
import type { HookClarificationRow } from "../../db/repositories/clarification-hooks.js";
import { logger } from "../../infra/logger.js";
import type { AnswerNotRecordedReason } from "./comment-format.js";

/**
 * Every comment that could be part of an answer: written by somebody who is not
 * us, in the window the answer was given in, with something in it. One filter,
 * used by the delivery that composes an answer out of comments and by the
 * record that counts its authors again later, so the two can never read the
 * same ticket differently.
 *
 * `throughMs` is the outer bound a recount carries, and it is the moment the
 * answer was stored. The words were complete then; anything said afterwards is
 * a conversation about them, and counting a "thanks" that arrived while a
 * resume was being retried would decline a perfectly good single person's
 * answer. It is only the outer bound: `composedAnswerEvidence` below closes the
 * window where the answer itself ends, which is what the composing delivery read
 * and therefore what both sides have to count.
 *
 * THE WINDOW IS (asked, answered]: open at the question, closed at the answer.
 * The two edges are spelled differently on purpose and round the same way,
 * away from crediting a decision to words nobody wrote as an answer to this
 * question. A comment stamped at the very instant the question was recorded
 * cannot be answering it, because the question reaches the ticket after that
 * instant, so it stays out. A comment stamped at the very instant the answer
 * was stored is part of what the composing delivery read, so it stays in:
 * dropping it would take an author off the count, and a count short by one is
 * how two people's words become one person's decision.
 */
export function qualifyingComments(
  comments: readonly TicketComment[],
  botAccountId: string,
  window: { afterMs: number; throughMs?: number },
): TicketComment[] {
  return comments.filter((c) => {
    // Comments without an accountId cannot be proven non-bot.
    if (!c.accountId || c.accountId === botAccountId) return false;
    // An app is not a person. Jira says so on every comment it knows the author
    // of, and only "app" is an account that decides nothing: an automation
    // rule, an integration, a webhook writing under its own identity. Dropped
    // here rather than in the count alone, so it leaves the composed answer and
    // the count together and nobody is answered on a robot's behalf.
    //
    // Only "app". A service desk customer and an ordinary Atlassian account are
    // both people, and an account type we have never seen is a person too: the
    // failure directions are not equal, and reading an unknown as an app would
    // silently start dropping real people's answers.
    //
    // THE LIMIT, SAID OUT LOUD: this catches automation that posts AS AN APP,
    // which is the common shape and the one that declines every answer on every
    // ticket. A Jira rule configured to comment as a named user is reported as
    // that user, so from this payload it IS a person, and it still costs that
    // answer its attribution. That case is open, not closed.
    if (c.accountType === "app") return false;
    // (asked, answered], as the doc above sets out.
    const createdAtMs = Date.parse(c.createdAt);
    if (createdAtMs <= window.afterMs) return false;
    if (window.throughMs !== undefined && createdAtMs > window.throughMs) return false;
    // An empty/whitespace body (e.g. an image-only comment flattened by
    // extractAdfText) is not an answer; treat it like no comment so the nudge
    // rules apply instead of resuming with a junk answer.
    return c.body.trim().length > 0;
  });
}

/**
 * Does this read hold every comment that could belong to an answer given after
 * `afterMs`?
 *
 * A different question from "is the whole ticket here", and a much easier one
 * to answer yes to. Completeness of the whole list is the adapter's honest
 * statement about what it read; this is the only part of it anybody here needs.
 * A ticket longer than one read may page through is read from its newest end,
 * so what is missing from it was written before what is present: if the read
 * vouches for everything since before the question was asked, then no answer to
 * that question is missing, however long the ticket is. Without this a ticket
 * with thousands of comments could never be answered through comments again,
 * which is an outage we would have inflicted on ourselves.
 *
 * False is still the answer when the read cannot say. A gap that could hide
 * somebody's words is the case every reader below must refuse: it must not
 * nudge a person who has answered, must not compose half a conversation into a
 * decision, and must not call an answer's evidence deleted.
 */
export function commentsCoverAnswerWindow(
  ticket: Pick<TicketContent, "commentsComplete" | "commentsCompleteFrom">,
  afterMs: number,
): boolean {
  if (ticket.commentsComplete === true) return true;
  if (ticket.commentsCompleteFrom === undefined) return false;
  const fromMs = Date.parse(ticket.commentsCompleteFrom);
  return Number.isFinite(fromMs) && fromMs <= afterMs;
}

/**
 * How many people an answer composed from comments came from, counted by
 * account id.
 *
 * The account id is the person; the display name is a label sitting on top of
 * one. Every comment reaching this count has an id, because `qualifyingComments`
 * drops the ones that do not, and that id answers the only question here
 * exactly: two people always hold two ids however they are named, and one
 * person renamed between two comments still holds one. Counting names instead
 * gets both of those wrong, and the second one wrong in the direction that
 * costs a person their answer: a display name is missing or generic on a
 * deactivated, anonymised or app-proxied author, so one person's two comments
 * can arrive under two names and stop being recorded for good.
 */
export function composedAuthorCount(comments: readonly TicketComment[]): number {
  return new Set(comments.map((c) => c.accountId)).size;
}

/**
 * The comments a composed answer is made of. ONE window, stated once, for the
 * delivery that composes the answer and for the recount that judges it later.
 *
 * The window opens at the question and closes at the last comment the answer's
 * own author wrote, not at a clock reading. Two clocks would give two answers:
 * the composing delivery reads the ticket, and the answer is stored a moment
 * later, so a recount bounded at the stored-at instant counts comments that
 * arrived in between, which are words the answer does not contain and nobody
 * delivered to the run. The same answer would then be one person's through the
 * channel that composed it and two people's through a channel that handed it
 * back, which is the one thing a recount exists to prevent.
 *
 * The last comment of the answer is knowable without reading a byte of it: the
 * composing delivery attributes the answer to whoever wrote last, and that
 * account id is on the row. Comments after it are a conversation the answer
 * never carried.
 *
 * WHERE THE TWO ARE NOT IDENTICAL, and they are not always: the composing
 * delivery also stops at the answer length cap, and which comments it had to
 * leave off is not written down anywhere. On a truncated answer this window is
 * therefore the wider of the two, and can hold a comment whose words are not in
 * the stored text. The consequence is a count that is too high rather than too
 * low, so such an answer is declined and the question asked again, which is the
 * direction this whole path rounds in: a repeated question is a cost, a
 * fabricated decision is a defect. Narrowing it would mean recording which
 * comments the text was built from, which is a column and a migration, and
 * nothing seen so far pays for that.
 */
function composedAnswerEvidence(input: {
  comments: readonly TicketComment[];
  botAccountId: string;
  afterMs: number;
  throughMs: number;
  authorAccountId: string;
}): TicketComment[] {
  const inWindow = qualifyingComments(input.comments, input.botAccountId, {
    afterMs: input.afterMs,
    throughMs: input.throughMs,
  });
  // Their LAST one: a person who answered, was asked to be more specific and
  // answered again wrote the whole of it, and the answer runs to the end of
  // what they said.
  let last: TicketComment | undefined;
  for (const c of inWindow) {
    if (c.accountId === input.authorAccountId) last = c;
  }
  // Nothing of theirs left in the window: whatever is here, the answer was not
  // composed from it, and the caller reads an empty set as evidence gone.
  if (!last) return [];
  const boundaryMs = Date.parse(last.createdAt);
  return inWindow.filter((c) => Date.parse(c.createdAt) <= boundaryMs);
}

/** Our own account id, or null when the provider will not say. Without it we
 *  cannot tell our own questions and nudges from a human answer, so every
 *  caller fails closed on null. */
export async function readBotAccountId(
  issueTracker: Pick<IssueTrackerAdapter, "getCurrentUserAccountId">,
  ticketKey: string,
): Promise<string | null> {
  try {
    const id = (await issueTracker.getCurrentUserAccountId?.())?.trim() ?? "";
    if (id) return id;
  } catch {
    // Fall through: identity unavailable.
  }
  logger.warn({ ticketKey }, "clarification_resume_bot_identity_unavailable");
  return null;
}

/**
 * How many people a STORED answer was composed from, counted again from the
 * comments it was composed from.
 *
 * A stored answer carries its text and its last commenter, never the number of
 * people behind it, and any channel can deliver it again: a byte-exact
 * resubmission through MCP or the dashboard takes the same retry path the cron
 * takes. So the count is taken from the ticket rather than from whoever is
 * delivering, and the same answer is judged on the same evidence however it
 * arrives.
 *
 * The two ways that fails are not the same thing, and the caller acts on them
 * differently.
 *
 * "cannot_count" is temporary: nothing was read, or we could not learn our own
 * identity, so our own questions and nudges are indistinguishable from a
 * person's words. Neither says anything about how many people wrote, and a
 * later delivery may well be able to say.
 *
 * "evidence_gone" is permanent: the ticket WAS read, and the comments the
 * answer was composed from are not on it. A composed answer came from at least
 * one comment, so none left means they were deleted, and no retry brings them
 * back.
 */
type ComposedAuthorRecount = number | "cannot_count" | "evidence_gone";

async function recountComposedAuthors(input: {
  issueTracker: Pick<IssueTrackerAdapter, "getCurrentUserAccountId">;
  ticketKey: string | null;
  comments: readonly TicketComment[] | null;
  commentsCoverWindow: boolean;
  answererId: string;
  afterMs: number;
  throughMs: number;
}): Promise<ComposedAuthorRecount> {
  // No ticket, or a delivery that read none: a composed answer comes from a
  // ticket's comments, so without them there is nothing to count yet.
  if (!input.ticketKey || input.comments === null) return "cannot_count";
  // A read with a gap in the answer's own window answers neither question here.
  // It cannot say the evidence is gone, because what is missing from it may
  // simply be on a page nobody read; and it cannot be counted either, because
  // the comment that would make this two people's words is exactly the one a
  // gap hides. A read that cannot be vouched for is ignorance, and ignorance
  // decides nothing.
  if (!input.commentsCoverWindow) return "cannot_count";
  const botAccountId = await readBotAccountId(input.issueTracker, input.ticketKey);
  if (botAccountId === null) return "cannot_count";
  const count = composedAuthorCount(
    composedAnswerEvidence({
      comments: input.comments,
      botAccountId,
      afterMs: input.afterMs,
      throughMs: input.throughMs,
      authorAccountId: composedAnswerAccountId(input.answererId),
    }),
  );
  return count === 0 ? "evidence_gone" : count;
}

/** The actor id a Jira comment answer is attributed to. It is the durable mark
 *  of the one channel that composes an answer out of whatever several people
 *  wrote, it stays on the row, and it is written and read back through this
 *  pair so the two can never drift apart. */
const COMPOSED_ANSWER_ACTOR_PREFIX = "jira:";

export function composedAnswerActorId(accountId: string): string {
  return `${COMPOSED_ANSWER_ACTOR_PREFIX}${accountId}`;
}

export function isComposedAnswerActor(actorId: string | null | undefined): boolean {
  return (actorId ?? "").startsWith(COMPOSED_ANSWER_ACTOR_PREFIX);
}

/** The account behind a composed answer's actor id: whoever commented last, and
 *  therefore where the answer's own window closes. Only ever asked of an id the
 *  check above accepted. */
function composedAnswerAccountId(actorId: string): string {
  return actorId.slice(COMPOSED_ANSWER_ACTOR_PREFIX.length);
}

/** Why a delivery is failed rather than delivered when the people behind a
 *  stored answer cannot be counted. It reaches a log and an HTTP response
 *  rather than the ticket, because a hold spends no delivery attempt and so
 *  never ends in the comment a spent budget posts. What the ticket is told,
 *  when the holding itself runs out, is `formatAnswerAuthorsUncountedComment`. */
export const UNCOUNTED_AUTHORS_ERROR =
  "the people who wrote this answer could not be counted from the ticket";

/**
 * How long an answer may be held back because WE cannot count its authors.
 *
 * A hold spends none of the person's three resume attempts, so nothing else
 * bounds it: the row stays answered and every later delivery tries again. That
 * is right while the failure is a moment of Jira being unhelpful, and wrong
 * once it is not, because the run stays parked on an answer that was already
 * given. Fifteen minutes is several cron deliveries, which is as many chances
 * as a transient failure needs, and short enough that nobody waits on it.
 * Measured from the moment the answer was stored, so every delivery reads the
 * same deadline rather than restarting it.
 */
const UNCOUNTED_AUTHORS_HOLD_WINDOW_MS = 15 * 60 * 1000;

/**
 * What a delivery may do with the answer it is holding.
 *
 * "write" is the ordinary answer, with however many people are known to be
 * behind it (none known, on the channels that are one person by construction).
 * "hold" is our own inability to count, which this delivery must not go ahead
 * on. "no_write" is an answer that decides nothing and stops nothing: a question
 * about no repository, evidence that is gone for good, or counting that has had
 * its window and spent it, which is the one case the ticket is told about.
 */
type AnswerAuthorship =
  | { kind: "write"; authorCount?: number; tell?: AnswerNotRecordedReason }
  | { kind: "hold" }
  | { kind: "no_write"; tell?: AnswerNotRecordedReason };

/**
 * Decide and record a person's answer to a repository question, once, here,
 * where it arrives.
 *
 * The three answer channels all reach this function, and a run dies seconds
 * after an answer often enough that reading it later loses it: the next run
 * then asks the same question, which is the defect the work scope record exists
 * to end. So the answer becomes entries before the run wakes up, and the
 * resumed run reads those entries rather than the sentence.
 *
 * An `answered` decision reads neither the catalog's usability nor the trigger
 * policy, which is why this tier, which knows neither, may make it.
 *
 * A clarification that asked about no repository takes none of this: every
 * question that is not about repositories, and every question asked before this
 * shipped, behaves exactly as it did. An answer more than one person wrote
 * takes half of it: the trail keeps the row saying an answer arrived, and no
 * entry is written, for the reason at the guard below.
 *
 * Returns "hold" when the people behind the answer cannot be counted RIGHT NOW.
 * Nothing is written then, and the caller must not deliver either: a delivery
 * that can count is what this answer is waiting for. A hold costs the person
 * none of their delivery attempts, and is bounded by a window of its own.
 *
 * Two cases are not that, and both write nothing and deliver anyway: evidence
 * that is gone for good, which no later delivery would count, and a hold whose
 * window has run out, which says on the ticket that the failure was ours. The
 * person is better asked again than left on a run this cancelled.
 */
export async function readAnswerAuthorship(input: {
  row: HookClarificationRow;
  answeredAt: Date;
  answerer: { id: string; label: string };
  authorCount?: number;
  issueTracker: Pick<IssueTrackerAdapter, "getCurrentUserAccountId">;
  ticketComments: readonly TicketComment[] | null;
  ticketCommentsCoverWindow: boolean;
}): Promise<AnswerAuthorship> {
  const askedRepositories = input.row.askedRepositories;
  // NO ASK AT ALL, WHICH IS NOT THE SAME AS AN ASK THAT LISTED NOTHING.
  //
  // A row with no asked list is a clarification that was not about repositories:
  // an agent asking which API shape to build, a plan waiting for approval. Its
  // answer is somebody's words on another subject entirely, and reading a
  // repository key out of "use Postgres, the pattern is in github:acme/api"
  // would record a decision nobody was asked to make. So it decides nothing,
  // and there is nothing to tell anybody about either.
  //
  // An EMPTY list is a repository question that named no repository, which is
  // the plain "which repository should this ticket modify?". That one is read,
  // and a person who answers it with a repository path has decided about that
  // repository (`packages/contracts/work-scope.ts`, where the two facts are
  // kept apart).
  if (askedRepositories === null || askedRepositories === undefined) {
    return { kind: "no_write" };
  }
  // Counted where the answer was composed, or counted again from the ticket,
  // and never guessed from which channel is delivering. A stored comment answer
  // comes back through any of them: resubmitting its exact text takes the same
  // resume retry path from the dashboard, from an MCP client and from the cron,
  // and none of those deliveries composed anything or carries a count. The
  // evidence they all share is the ticket the answer was composed from, so that
  // is what decides, and one answer is judged the same way however it arrives.
  const authorCount =
    input.authorCount === undefined && isComposedAnswerActor(input.answerer.id)
      ? await recountComposedAuthors({
          issueTracker: input.issueTracker,
          ticketKey: input.row.ticketKey,
          comments: input.ticketComments,
          commentsCoverWindow: input.ticketCommentsCoverWindow,
          answererId: input.answerer.id,
          afterMs: input.row.askedAt.getTime(),
          throughMs: input.answeredAt.getTime(),
        })
      : input.authorCount;

  // Counting is not the same as counting more than one, and only the second is
  // a decision. Our own identity unavailable, or a ticket nobody read, says
  // nothing at all about how many people answered, and the write here happens
  // once per clarification, so spending it on a moment of Jira being unhelpful
  // would unrecord a good answer for good. Decide nothing, and hand the caller a
  // delivery to fail rather than a resume to perform, so the answer is still
  // there for a delivery that can count it.
  if (authorCount === "cannot_count") {
    // Held, but not forever. A hold costs the person nothing, which is the
    // point of it standing outside the resume budget, and that is exactly why
    // it needs a bound of its own: an identity endpoint that is down for good,
    // or a ticket too long to read to the end, would otherwise leave the run
    // parked with a delivered answer nobody is waiting on any more. The bound
    // runs from the moment the answer was stored, so it is the same window
    // however many deliveries try inside it.
    const heldForMs = Date.now() - input.answeredAt.getTime();
    if (heldForMs < UNCOUNTED_AUTHORS_HOLD_WINDOW_MS) {
      logger.warn(
        { runId: input.row.runId, clarificationId: input.row.id },
        "work_scope_answer_not_counted",
      );
      return { kind: "hold" };
    }
    logger.warn(
      { runId: input.row.runId, clarificationId: input.row.id, heldForMs },
      "work_scope_answer_not_counted_gave_up",
    );
    // The ticket is told, because the person gave a good answer and something
    // they cannot see decided not to keep it. The caller posts it, once the
    // delivery it belongs to is the one going ahead.
    return { kind: "no_write", tell: "uncounted" };
  }

  // The other half of that, and the opposite conclusion. The ticket was read
  // and the comments the answer was composed from are gone: there is no later
  // delivery that counts them, so holding the answer back only spends the
  // delivery budget and ends in a cancelled run and a sentence nobody can act
  // on. Nothing is written, the resume goes through on the words the person
  // already saw, and the next run asks the question again. A repeated question
  // is a cost; a run cancelled on somebody who answered correctly is worse.
  if (authorCount === "evidence_gone") {
    logger.warn(
      { runId: input.row.runId, clarificationId: input.row.id },
      "work_scope_answer_evidence_gone",
    );
    // And said on the ticket. The question comes back on the next run, and a
    // person who is asked twice is owed the reason both times.
    return { kind: "no_write", tell: "evidence_gone" };
  }

  if (authorCount === undefined) return { kind: "write" };
  // Written, and written as a decline: the entries are the record's business
  // and the sentence is the person's. Several people wrote these words, so the
  // record keeps none of them as anybody's decision, and the person who
  // answered would otherwise see only the same question again.
  return authorCount > 1
    ? { kind: "write", authorCount, tell: "several_authors" }
    : { kind: "write", authorCount };
}
