import type { WorkScopeAskReason } from "@shared/contracts";
import type { UnrecordedAnswerCommentPath } from "../work-scope/context.js";
import { scrubForPublication } from "./publication-scrub.js";

/**
 * Pure text builders for the Jira comments that carry clarification questions
 * to a human. Kept free of env/adapter imports so both the workflow (posting)
 * and any later resume path (nudge / already-answered replies) can reuse them
 * and test them in isolation. The Jira adapter turns newlines into ADF
 * paragraphs, so these emit plain text with blank lines between sections.
 */

/**
 * Substring a later stage matches to recognize its own nudge comment and avoid
 * re-posting it. Must appear verbatim in the nudge body.
 */
export const CLARIFICATION_NUDGE_MARKER =
  "still waiting for answers to its clarification questions";

/** Format an ISO instant as a human-readable UTC minute, e.g. `2026-07-29 14:03 UTC`. */
function formatUtcMinute(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/**
 * The full questions comment posted when a run pauses for clarification.
 *
 * `questions` and `suggestedAnswers` are the only agent-authored strings here:
 * they arrive from the research/implementation phase's structured output, or
 * from a human_question block's params, and are published verbatim into the
 * customer's ticket. Both go through scrubForPublication, the same output-side
 * control the PR body and the ticket-comment block use, because the agent has
 * been observed reporting its platform bookkeeping in prose it was asked to
 * write for a customer.
 *
 * Everything else in the comment is ours: the section labels, the numbering, the
 * dashboard URL, the configured column name and the expiry sentence. They are
 * correct by construction, so scrubbing them could only corrupt them. The scrub
 * is per field rather than over the composed comment for the same reason, and
 * because removing a whole numbered item would silently renumber the list a
 * human is about to answer.
 */
export function formatClarificationQuestionsComment(input: {
  questions: string[];
  suggestedAnswers: string[] | null;
  dashboardUrl: string;
  aiColumnName: string;
  expiresAtIso: string | null;
  /** What a person can do about a repository this run left out, when the
   *  questions above are about repositories and something was refused. Ours,
   *  and the ticket comment is the only channel it travels on: see the ruling
   *  at the call site in `engine/agent-workflow.ts`. Optional, so every other
   *  clarification comment is byte-identical to what it was. */
  repositoryRecoveryNotes?: string[];
}): string {
  const sections: string[] = [
    "The AI workflow needs clarification before it can continue with this ticket:",
    input.questions.map((q, i) => `${i + 1}. ${scrubForPublication(q)}`).join("\n"),
  ];

  // Straight under the questions, because it is about the repository named in
  // one of them, and above "How to answer" because it widens what an answer
  // could be: a person who thinks the repository is gone for good answers a
  // narrower question than the one actually in front of them. Unscrubbed for
  // the reason the paragraph above gives: this text is ours.
  if (input.repositoryRecoveryNotes && input.repositoryRecoveryNotes.length > 0) {
    sections.push(input.repositoryRecoveryNotes.join(" "));
  }

  if (input.suggestedAnswers && input.suggestedAnswers.length > 0) {
    sections.push(
      [
        "Suggested answers:",
        ...input.suggestedAnswers.map((s) => `- ${scrubForPublication(s)}`),
      ].join("\n"),
    );
  }

  sections.push(
    [
      "How to answer:",
      `- In the dashboard: ${input.dashboardUrl}`,
      `- Or reply in a comment on this ticket and move it back to the "${input.aiColumnName}" column.`,
    ].join("\n"),
  );

  if (input.expiresAtIso) {
    sections.push(
      `The paused run is resumable until ${formatUtcMinute(input.expiresAtIso)}. After that the ticket starts over from scratch.`,
    );
  }

  return sections.join("\n\n");
}

/** Short reminder that a parked run is still waiting on answers. */
export function formatClarificationNudgeComment(input: {
  dashboardUrl: string;
  aiColumnName: string;
}): string {
  return [
    `The AI workflow is ${CLARIFICATION_NUDGE_MARKER} on this ticket.`,
    `Answer in the dashboard (${input.dashboardUrl}) or reply in a comment here and move the ticket back to the "${input.aiColumnName}" column.`,
  ].join("\n");
}

/**
 * Where an answer came from, as the channel that took it states it.
 *
 * NEVER READ OUT OF A LABEL. An MCP client answers signed with its OAuth
 * client id ("MCP fBEUsk..."), and a person in the dashboard may be called
 * anything at all, so only the surface that took the answer can say which one
 * it was.
 */
/**
 * Where an answer arrived, as the caller states it.
 *
 * Only the surfaces this comment is posted for: an answer that arrived as a
 * comment on this very ticket is its own trace and gets none, so there is no
 * wording for one.
 */
export type ClarificationAnswerSurfaceComment =
  | { kind: "dashboard" }
  /** `person` is whoever is behind the client, when the deployment knows and
   *  the label is a name rather than an address. */
  | { kind: "mcp"; clientId: string; person: string | null };

function answeredWhere(label: string, surface: ClarificationAnswerSurfaceComment): string {
  if (surface.kind === "dashboard") {
    return `${label} answered the clarification in the dashboard; the run is resuming.`;
  }
  return surface.person
    ? `${surface.person} answered the clarification through the MCP client ${surface.clientId}; the run is resuming.`
    : `The MCP client ${surface.clientId} answered the clarification; the run is resuming.`;
}

/**
 * Trace posted to the ticket when a clarification is answered somewhere other
 * than the ticket itself: the dashboard, or an MCP client. Without it the public
 * questions comment ends in silence: the ticket shows a question, then a status
 * change, and nothing that explains what unblocked the run. The Jira comment
 * path needs no trace, because the human's own comment already is one and this
 * would echo it back at them.
 *
 * IT SAYS WHERE THE ANSWER REALLY CAME FROM. Every answer used to read as "in
 * the dashboard", so an MCP client's answer arrived on the ticket signed with
 * an OAuth client id and a sentence that was not true.
 *
 * The answer is human-authored, not agent-authored, and goes back into the
 * ticket that same human is invited to comment on, so it is published verbatim:
 * scrubbing here would edit a person's own words. Its length is already bounded
 * by MAX_ANSWER_LENGTH where the answer enters.
 */
export function formatClarificationAnswerComment(input: {
  answeredByLabel: string;
  answer: string;
  surface: ClarificationAnswerSurfaceComment;
}): string {
  return [
    answeredWhere(input.answeredByLabel, input.surface),
    ["Answer:", input.answer.trim()].join("\n"),
  ].join("\n\n");
}

/**
 * Posted when a stored answer could not be delivered to its paused run within
 * the attempt budget. The run is stopped by then, so the ticket has to say so:
 * a human who answered here would otherwise see the answer accepted and then
 * nothing at all. The error is provider text, already truncated by the caller.
 */
export function formatClarificationResumeFailedComment(input: {
  attempts: number;
  error: string;
}): string {
  return [
    `The answer to this clarification was received, but the AI workflow could not resume the paused run after ${input.attempts} attempts, so the run was stopped.`,
    `Last error: ${input.error}`,
    "To retry, start a new run for this ticket.",
  ].join("\n\n");
}

/** One-liner acknowledging that a clarification was answered and the run resumes. */
export function formatAlreadyAnsweredComment(input: { answeredByLabel: string }): string {
  return `This clarification was already answered by ${input.answeredByLabel}; the run is resuming.`;
}

/**
 * Line the cancellation comment below carries verbatim, so a tracker that can
 * search its own comments (findCommentByMarker) recognises one this deployment
 * already posted and does not post a second. Per RUN, not per ticket: a later
 * run that asks its own questions and is cancelled has its own silence to
 * break, and suppressing that would be the same defect one ticket further on.
 */
export function clarificationCancelledCommentMarker(runId: string): string {
  return `AI workflow clarification closed: ${runId}`;
}

/**
 * The counterpart of formatClarificationQuestionsComment, posted when the run
 * that asked those questions is cancelled.
 *
 * The questions comment is the only thing on the ticket that says a question is
 * open, and the only thing that invited an answer here, so the ticket is where
 * the question has to be closed too. Without this a cancelled park leaves a
 * question that reads as open for its full week, and an answer written to it
 * reaches nobody.
 *
 * It deliberately promises nothing about an answer already written. The run
 * that asked is gone, its clarification row is retired, and the next run reads
 * none of it as an answer, so the one sentence a person needs is that no answer
 * can land any more.
 */
export function formatClarificationCancelledComment(input: {
  runId: string;
  aiColumnName: string;
}): string {
  return [
    "The AI workflow run that asked for clarification on this ticket was stopped, so its questions are no longer open.",
    "No answer to them can be delivered any more, including one already written on this ticket.",
    [
      "What you can do:",
      `- Move this ticket back to the "${input.aiColumnName}" column. That starts a new run, which works the ticket from scratch and asks again if it still needs to know.`,
    ].join("\n"),
    clarificationCancelledCommentMarker(input.runId),
  ].join("\n\n");
}

/**
 * Every way an answer that reached the run can leave no repository decision
 * behind it, each with the sentence that explains it to the person who wrote it.
 *
 * THE MAP IS THE LIST. `AnswerNotRecordedReason` is its keys, so a new reason
 * cannot be declared without the sentence that explains it, and the rule 6 test
 * walks this object instead of a literal list beside it that somebody has to
 * remember to extend. A type cannot be enumerated at runtime; this is the
 * narrowest thing that can, and it is the thing every reason must have. The
 * count is deliberately not written here: it was "a seventh reason" while the
 * map held nine, which is how a comment that counts stops being true.
 */
const ANSWER_NOT_RECORDED_WHY = {
  /** Several people wrote into the one answer, so no single person can be
   *  credited with the decision it adds up to. */
  several_authors:
    "More than one person wrote into this answer, so the AI workflow could not tell whose decision it is and recorded no repository decision from it.",
  /** The comments the answer was composed from are no longer on the ticket. */
  evidence_gone:
    "The comments this answer was composed from are no longer on the ticket, so the AI workflow could not tell how many people wrote it and recorded no repository decision from it.",
  /** We could not establish how many people wrote it, and gave up waiting. */
  uncounted:
    "The AI workflow could not establish from this ticket how many people wrote that answer, so it recorded no repository decision from it. That is a limitation on our side, not a problem with the answer.",
  /** It arrived as a comment on the ticket and reads as a plain no, which says
   *  nothing about what it is refusing. */
  unaddressed_refusal:
    "This answer arrived as a comment on the ticket and reads as a plain no. Comments here are written for all sorts of reasons, and a no on its own does not say which repositories it is about, so the AI workflow recorded no repository decision from it rather than leaving repositories out in your name.",
  /** It was read, and nothing in it named a repository the record could keep,
   *  so the question it answered is still open. Nothing it named was spelled
   *  out as a path, so writing one out is the remedy that works. */
  no_repository_named:
    "Nothing in that answer named a repository this work should use, so the AI workflow recorded no repository decision from it.",
  /** It spelled a repository path out in full, and this deployment holds no
   *  repository by that name. The difference from the reason above is the whole
   *  reason this one exists: writing that path out again reaches the next run
   *  and still resolves to nothing. */
  no_such_repository:
    "That answer named a repository this deployment does not have, so the AI workflow recorded no repository decision from it.",
  /** It had no word in it at all, a thumbs up or a full stop, which the run
   *  takes as nothing left to attach and the record takes as nothing said. */
  no_words:
    "That answer has no words in it, so there was nothing in it to read and the AI workflow recorded no repository decision from it. A thumbs up reads as agreement to a person and as nothing at all here.",
  /** It named a repository the question listed as already part of this work,
   *  to drop it or only to keep it. A reply does not change those, and nothing
   *  else in it could be read as a decision. */
  names_kept_repository:
    "That answer names a repository the question listed as already part of this work. A reply to that question does not change those, and the AI workflow could not read a decision about the other repositories from it, so it recorded no repository decision from it.",
  /** It was a word that counts repositories ("both", "all three"), saying a
   *  different number from the one the question listed. The word and the list
   *  contradict each other, so neither of them can be acted on. */
  counting_word_and_list_disagree:
    "That answer is a word for a number of repositories, and it is not the number the question listed, so the AI workflow could not tell which of them were meant and recorded no repository decision from it.",
  /** It named a repository and also said no, and the no could not be tied to
   *  the repositories it was about. */
  refusal_beside_named:
    "That answer names a repository and also says no, and the AI workflow could not tell which repositories the no was about, so it recorded no repository decision from it rather than choosing for you.",
};

/** Why an answer that reached the run left no repository decision behind it. */
export type AnswerNotRecordedReason = keyof typeof ANSWER_NOT_RECORDED_WHY;

/** Every reason there is, for a caller that has to hold all of them to one
 *  rule rather than to the ones it happened to think of. */
export const ANSWER_NOT_RECORDED_REASONS = Object.keys(
  ANSWER_NOT_RECORDED_WHY,
) as AnswerNotRecordedReason[];

/**
 * Could a later run pick a repository this question listed up out of a comment,
 * answered one ask reason at a time.
 *
 * THE MAP IS THE LIST, the same rule `ANSWER_NOT_RECORDED_WHY` above is written
 * to: a fifth ask reason cannot be declared without somebody answering this
 * question for it, because the type will not let it. A list of the false ones
 * would leave a new reason silently true, and silently true here is the
 * sentence that sends a person down a route that cannot work.
 *
 * ONE ROUTE IS BEING JUDGED, and it is the one the sentence promises: a person
 * writes a repository's full path in a comment, and the NEXT run reads the
 * ticket and picks it up. That run matches paths against the repositories it
 * FROZE at its start (`ticketText` and `mentionsRepositoryPath` in
 * `engine/pre-sandbox/steps/repo-selection.ts`, scanning `scopedRepositories`),
 * so the only question per reason is whether a repository asked about for that
 * reason is in that list.
 */
const A_LATER_RUN_CAN_PICK_IT_UP: Record<WorkScopeAskReason, boolean> = {
  /** NO. The frozen list IS the enabled list, so a repository the catalog does
   *  not enable is not in it: the path a person writes matches nothing, and
   *  nothing is said a second time. Only the catalog can change that. */
  not_enabled: false,
  /** NO, and by a SECOND mechanism on the same path, which is why it lands here
   *  beside `not_enabled` rather than with the two below. The matcher scans
   *  `scopedRepositories`, which descends from `usableRepositories`, so a
   *  repository this deployment enables but cannot serve (no default branch, as
   *  the catalog builds usability today) is filtered out before one path is
   *  compared. Enabled-but-unserveable and not-enabled are different facts
   *  about the catalog, and a later delivery may well want to say different
   *  things about them; this predicate answers only whether writing the path
   *  out reaches anything, and for both the answer is no. */
  unusable: false,
  /** YES. The repository is one this deployment holds and can serve, so it is
   *  in the frozen list and the path is read. What kept it out of this run was
   *  the trigger's policy, and a policy binds which repositories the RUN may
   *  take, never which paths the matcher can see. */
  outside_policy: true,
  /** YES. Every repository a selection question lists is one the run could have
   *  taken, which is what made it a choice worth putting to somebody at all. */
  selection: true,
};

/**
 * Could a later run pick up ANY of the repositories this question listed, if
 * somebody wrote its full path in a comment?
 *
 * ANY, not every, and the direction is deliberate. A question that listed one
 * repository the next run can match and one it cannot still has a working path
 * route, and telling that person it reaches nothing would be the same false
 * sentence with its sign flipped. What is left is the mixed question, where a
 * person who writes the path of the blocked one alone gets silence; this
 * decides which of the two sentences is true of the question as a whole, and
 * the wider one is the one that stays true for somebody.
 *
 * An empty or absent list answers false, and nothing reads that answer: it is
 * the question that listed no repositories at all, which the formatter sends
 * down its other branch.
 */
export function aLaterRunCanPickUpAskedRepositories(
  asked: readonly { askedBecause: WorkScopeAskReason }[] | null | undefined,
): boolean {
  return (asked ?? []).some((repository) => A_LATER_RUN_CAN_PICK_IT_UP[repository.askedBecause]);
}

/**
 * Posted when the answer reached the run and left no repository decision behind
 * it, which is a thing the person who answered cannot see and would otherwise
 * only learn by being asked the same question again.
 *
 * The rule it serves: nobody is asked something they have already answered
 * without being told why. Three things, in this order: what happens to this run
 * now, what became of their words and why, and what to write so the next run
 * picks it up.
 *
 * NEVER AN INSTRUCTION TO REPLY INTO THIS QUESTION. By the time this is posted
 * the clarification is answered, and the comment path only ever reads a pending
 * one (`db/repositories/clarification-hooks.ts`, which answers a row only while
 * its status is `pending`). A person who did as such a sentence said would
 * write "none" underneath it and watch nothing happen at all, which teaches
 * them the system is broken more thoroughly than silence would.
 *
 * What does work is two routes, and both are named from what the code actually
 * does. A full repository path written in any comment here is read by the NEXT
 * run, because the path matcher takes the whole ticket including people's
 * comments (`ticketText` in `engine/pre-sandbox/steps/repo-selection.ts`, which
 * leaves out only our own). And a refusal has one route, which is the question
 * itself: a comment IS how the ticket answers a question that is still open, and
 * "none" written there declines every repository it listed, entry and all
 * (A7, A17d). What has no route is a refusal written under a question already
 * answered, which is when this comment is posted, so that is what the sentence
 * says. It used to say that nothing written on this ticket can record a refusal,
 * which was false the moment the words left the sentence: this same delivery
 * posts `formatAnswerDeclinedComment` on this same ticket to tell somebody their
 * comment declined four repositories.
 *
 * AND THE ONE THING A COMMENT CANNOT DO, said beside it, because the two look
 * identical to whoever writes them: a bare "no" is not read as an answer to our
 * question, since nothing threads a comment to it and the same word may be about
 * the comment above ours (A8). The word the question teaches is the word that
 * works, on this channel and on the two that type into a box.
 *
 * THE ONE PERSON THE PATH ROUTE IS FALSE FOR. "We could not read a repository
 * out of that" is two cases, and the remedy is only true for one of them. A
 * person who wrote a bare or partial name is told to write the path in full,
 * and writing it in full may well resolve. A person who already wrote the path
 * in full, for a repository this deployment does not hold, would write the same
 * words again for the next run to resolve to the same nothing. They get
 * `no_such_repository` instead, which says what is actually wrong and names the
 * screen where a repository is added or enabled. Where one answer carries both
 * shapes, this is the fuller explanation and it is still true for them, so it
 * is the one they get.
 *
 * AND A SECOND PERSON, REACHED THROUGH A DIFFERENT DOOR: the one WE named it
 * to. The case above is a repository the PERSON wrote down and this deployment
 * does not hold. This one is a repository the run itself put in front of them,
 * because a question may list one the catalog does not enable or cannot serve.
 * The path route is false for that person too, and for the same mechanical
 * reason: the next run matches paths against the repositories it froze at its
 * start, and such a repository is not among them. Sending them off to write a
 * path spends their second attempt on a route that cannot work and says
 * nothing at all when it fails, which is worse than the first case, because
 * there the person picked the name and here we did.
 * `question.aLaterRunCanPickThemUp` is that missing fact, and where it is
 * false the sentence names the catalog instead, which is the only thing that
 * can change the answer. `A_LATER_RUN_CAN_PICK_IT_UP` above answers that for
 * each ask reason in turn, and says there why `unusable` sits with
 * `not_enabled`.
 *
 * ONE KEYWORD, AND IT IS THE ONE THE QUESTION TEACHES. The expansion question
 * says `Reply "none"` (`engine/repository-discovery/runner.ts`), so this says
 * "none" too. A second phrase for the same act would teach that the exact words
 * matter and then hand the person two of them.
 *
 * `question.listedCount` is what they had in front of them, and it
 * decides which words are offered back. A question that listed none never
 * offered "none" to anybody, and answering it that way would record nothing, so
 * that case is told to name a path instead.
 *
 * AND EVERYBODY ELSE A QUESTION LISTED REPOSITORIES TO, by count rather than
 * by catalog. Whether a written path is taken depends on how many open
 * repositories the ticket names with it, and this surface has no run behind it
 * and cannot count them. The which-of-these question about the ticket's text is
 * raised only while more than three stand, so there the sentence says why the
 * route is shut; on every other question it says nothing about the route at
 * all. `question.commentPath` is that fact, decided by
 * `commentPathAfterAnUnrecordedAnswer` (`engine/work-scope/context.ts`), and on
 * both branches the sentence names only routes that work: naming one when the
 * question comes back, and the work's repository list. We may under-promise
 * here, never over-promise. The question that listed no repository at all
 * still offers the path route, which this surface cannot prove either; that is
 * an open row (C11o).
 */
export function formatAnswerNotRecordedComment(
  reason: AnswerNotRecordedReason,
  question: {
    /** How many repositories the question put in front of the person. None
     *  means it listed no repository at all; one makes every sentence about
     *  them singular, which a question about one repository needs. */
    listedCount: number;
    /** Could a later run's path matcher pick those repositories up out of a
     *  comment? Read only where the question listed repositories. */
    aLaterRunCanPickThemUp: boolean;
    /** What may be said about writing one of their paths in a comment. Never
     *  that it works, because nothing on this surface can prove it:
     *  "too_many_open" where the ticket names more open repositories than a run
     *  decides between, so the sentence says why the route is shut;
     *  "unproven" everywhere else, so the sentence names only routes that work.
     *  Decided by `commentPathAfterAnUnrecordedAnswer` in
     *  `engine/work-scope/context.ts`. Read only where both facts above are
     *  true. */
    commentPath: UnrecordedAnswerCommentPath;
  },
): string {
  // What happens to this run. The same for every reason but one: a wordless
  // answer to a question that named repositories ends the run's own asking, and
  // it carries on WITHOUT them. That is the fact the person most needs and the
  // one they can least see, because a thumbs up reads as approval.
  //
  // AND WHAT IT DID NOT DO. A wordless answer ends THIS run's asking and
  // records nothing at all: it is read as nothing said rather than as "none"
  // (`saysNothingToAttach` in `engine/work-scope/answer.ts`), so the
  // repositories it dropped are not decided against, and a later run may take
  // them. Saying only the first half reads as a decision this person made for
  // good, which is the opposite of what happened.
  const listedRepositories = question.listedCount > 0;
  // Singular where the question was about one repository: "the repositories"
  // and "them" about a single name reads as if more than one had been asked
  // about.
  const one = question.listedCount === 1;
  const nowThisRun =
    reason === "no_words" && listedRepositories
      ? one
        ? "Your answer reached the run, which is continuing without the repository the question asked about." +
          " Nothing was recorded about it, so a later run may use it and may ask about it again."
        : "Your answer reached the run, which is continuing without the repositories the question asked about." +
          " Nothing was recorded about them, so a later run may use them and may ask about them again."
      : "Your answer reached the run, which is continuing.";

  // The route that works, written from what the next run actually reads. The
  // middle branch is the one the run itself can close: it listed repositories,
  // and none of them is one a written path could reach. Singular where the
  // question was about one repository: "one of their paths" about a single
  // repository reads as if the person had missed some.
  const namingWorks = listedRepositories
    ? question.aLaterRunCanPickThemUp
      ? question.commentPath === "too_many_open"
        ? tooManyNamedForAComment
        : onlyTheRecordIsProven(one)
      : onlyTheCatalogCanOpenThese(one)
    : "Write the full path of the repository this work should use in a comment here, for example github:acme/app, and the next run reads this ticket and picks it up.";
  // The route that does not exist, said plainly instead of implied. Only worth
  // saying where the question offered repositories to decline.
  const decliningHasNoShortcut =
    'A refusal written under this question now records nothing, because it is already answered. When the question comes back, answering "none" declines every repository it lists; a bare "no" in a comment does not, because nothing ties a comment to the question it was meant for.';
  const next: Record<AnswerNotRecordedReason, string> = {
    several_authors: `${ASKED_AGAIN_ON_A_LATER_RUN} ${ONE_PERSON_ANSWERING_IT} ${namingWorks}`,
    evidence_gone: `${ASKED_AGAIN_ON_A_LATER_RUN} ${ONE_PERSON_ANSWERING_IT} ${namingWorks}`,
    uncounted: `${ASKED_AGAIN_ON_A_LATER_RUN} ${ONE_PERSON_ANSWERING_IT} ${namingWorks}`,
    unaddressed_refusal: `${ASKED_AGAIN_ON_A_LATER_RUN} ${decliningHasNoShortcut} ${namingWorks}`,
    no_repository_named: listedRepositories
      ? `${ASKED_AGAIN_ON_A_LATER_RUN} ${decliningHasNoShortcut} ${namingWorks}`
      : `${ASKED_AGAIN_ON_A_LATER_RUN} ${namingWorks}`,
    // NOT `namingWorks`, and that is the point of the reason. They already
    // wrote the path; the next run would read the same words and resolve them
    // to the same nothing, so sending them back to write it again is the dead
    // end rule 6 is about. What is true instead is that the name may be wrong
    // and that the deployment's own repository list is a thing a person can
    // add to.
    no_such_repository: `${ASKED_AGAIN_ON_A_LATER_RUN} ${checkTheNameOrAddIt}`,
    // Nothing about declining here: the run has already carried on without
    // them, which is what a refusal would have done.
    no_words: `${ASKED_AGAIN_ON_A_LATER_RUN} ${namingWorks}`,
    // Two separate moves, because they were one sentence the person could not
    // make: a kept repository leaves when the reason it is there goes, and
    // choosing among the others happens when the question comes back.
    names_kept_repository: `${ASKED_AGAIN_ON_A_LATER_RUN} ${keptStayUntilTheirReasonGoes} ${NAME_ONLY_THE_ONES_TO_USE} ${namingWorks}`,
    refusal_beside_named: `${ASKED_AGAIN_ON_A_LATER_RUN} ${NAME_ONLY_THE_ONES_TO_USE} ${namingWorks}`,
    // The one reason whose remedy is a different word rather than more words:
    // the reply was unambiguous and simply disagreed with the list, so the
    // person needs the word that means every repository the question lists, or
    // the names themselves. Without this they read that their answer named no
    // repository, which says nothing about the count, and the obvious second
    // attempt is the same word.
    counting_word_and_list_disagree: `${ASKED_AGAIN_ON_A_LATER_RUN} ${EVERY_ONE_THE_QUESTION_LISTS} ${namingWorks}`,
  };
  return [nowThisRun, ANSWER_NOT_RECORDED_WHY[reason], next[reason]].join("\n\n");
}

/**
 * Whether declining a repository the question listed for THIS reason writes an
 * entry into the record.
 *
 * The map is the list, like the two above it, so a fifth ask reason cannot be
 * declared without somebody answering this question for it.
 *
 * It exists because the sentence below used to answer it one way for every
 * reason and was false for the commonest one. Production, AWP-263 on
 * 2026-09-20: a person declined the one candidate a which-of-these question
 * offered, was told "this work is recorded as leaving it out", read the record
 * straight afterwards, found no entry for it and a dashboard saying nobody had
 * decided about it, and reported a lost answer. Their answer was not lost; the
 * sentence named the wrong place.
 */
const A_DECLINE_WRITES_AN_ENTRY: Record<WorkScopeAskReason, boolean> = {
  /** YES, `unavailable`, which expires once the catalog can use the repository
   *  (A7b): the person could not have it, so they did not refuse it. */
  not_enabled: true,
  /** YES, `unavailable` again and for the same reason. */
  unusable: true,
  /** YES, `excluded`: the person could have had it and said no, and the
   *  trigger policy that kept it out of this run does not expire (A7b). */
  outside_policy: true,
  /** NO, and that is the product decision A7 holds, not an omission. A name
   *  left out of an answer is a weaker thing than an entry, so the question,
   *  the repositories it NAMED and the answer naming none of them are the whole
   *  of the decision, and they live on the Decision Trail. A later run reads
   *  them there and neither offers the repository again nor takes it
   *  (`readWorkScopeAnsweredRepositories`, `isUnnamedInAnswer`). */
  selection: false,
};

/**
 * What a DECLINE decided, for the channel that took it.
 *
 * A bare "no" typed into the dashboard's box or sent through
 * `runs_answer_clarification` is an answer to the question in front of that
 * person, so it declines every repository the question listed, permanently and
 * in their name. Those two channels used to say nothing at all about it. The
 * screen said "answered" and the rule lived in an MCP tool description
 * that no human ever reads, so the most consequential thing a one word answer
 * can do was also the least visible.
 *
 * WHERE THE DECISION LANDS IS SAID PER REASON, because it differs and a person
 * goes looking for it. A decline of a repository the deployment cannot serve or
 * the policy holds back is an entry in the record; a decline on the
 * which-of-these question writes no entry by design, and telling somebody it
 * did sends them to a list that will not have it and teaches them the system
 * loses answers. What is true of that one is the sentence its sibling
 * `formatAnswerLeftOutComment` already uses for the silent half of the same
 * decision, word for word, so the two halves of one rule read as one rule.
 *
 * This sentence goes to the answer's own reply and NOT to the ticket: the
 * ticket comment exists for answers that recorded nothing, and a decline
 * decided exactly what it looks like it decided. It names the way back, because
 * its readers are people and it never reaches a prompt (rule 7).
 *
 * ONE WAY BACK FOR EVERY KIND OF QUESTION, and it carries the catalog clause on
 * purpose. A question lists repositories for three different reasons, and a
 * decline of one asked because the deployment does not enable it cannot be
 * undone by a selection alone: `work_scope.edit` refuses to select a key the
 * repository catalog does not enable and writes nothing. A sentence per reason
 * would be four wordings for one screen, so the clause that is true of all of
 * them is here instead, and a person whose repository is simply excluded reads
 * a condition that does not apply to them rather than a route that does not
 * work.
 */
export function formatAnswerDeclinedComment(
  repositoryKeys: readonly string[],
  /** The question's own asks, for the reason each declined repository was put
   *  in front of this person. A key the list does not carry takes the branch
   *  that claims nothing about the record: we may under-promise here, never
   *  over-promise. */
  askedRepositories?: readonly { repositoryKey: string; askedBecause: WorkScopeAskReason }[],
): string {
  const writesAnEntry = (repositoryKey: string) => {
    const asked = (askedRepositories ?? []).find(
      (repository) => repository.repositoryKey === repositoryKey,
    );
    return asked !== undefined && A_DECLINE_WRITES_AN_ENTRY[asked.askedBecause];
  };
  const recorded = repositoryKeys.filter(writesAnEntry);
  const onTheTrail = repositoryKeys.filter((key) => !writesAnEntry(key));
  const sentences: string[] = [];
  if (recorded.length > 0) {
    sentences.push(
      `Your answer was read as declining ${recorded.join(", ")}, which the question listed, so this work is recorded as leaving ${recorded.length === 1 ? "it" : "them"} out.`,
    );
  }
  if (onTheTrail.length > 0) {
    const them = onTheTrail.length === 1 ? "it" : "them";
    sentences.push(
      `Your answer was read as declining ${onTheTrail.join(", ")}, which the question listed, so ${onTheTrail.length === 1 ? "it is" : "they are"} left out of this work, and no later run takes ${them} on its own.`,
      // Where to look, because the person who reads this goes and looks. The
      // repository list will not carry it, and a list that does not carry a
      // decision somebody just made reads as a decision that was dropped.
      `You will find the question and your answer on this work's Decision Trail rather than in its repository list.`,
    );
  }
  sentences.push(theWayBackIntoTheWork(repositoryKeys.length));
  return sentences.join(" ");
}

/** The one way back, written once, because a person meeting it after a decline
 *  and a person meeting it after an answer that named something else are being
 *  told the same thing and a second wording would read as a second rule. */
function theWayBackIntoTheWork(count: number): string {
  return `To bring ${count === 1 ? "it" : "one of them"} back, select it in this work's repository list, through the work scope API or the work_scope.edit tool; a repository this deployment does not enable has to be enabled on the repositories screen first, or that selection is refused.`;
}

/**
 * WHAT WE COULD NOT ACT ON, SAID OUT LOUD.
 *
 * A person answers "api and web" to a question that only offered api. Their
 * decision about api is perfectly clear and is recorded; web is not, because a
 * reading may never widen what was asked, and the keys the question put in
 * front of somebody are the only ones that become a decision.
 *
 * WITHOUT THIS SENTENCE THAT IS THE SYSTEM QUIETLY DOING HALF THE JOB. They
 * named two repositories because they believe both are needed, the run works on
 * one of them and finishes green, and they find out when the pull request is
 * missing the other half, with nothing anywhere saying why. That is the exact
 * shape of the failure this whole path exists to end, so the half we could not
 * act on is named rather than swallowed.
 *
 * WHAT IT IS NOT is a second question. The part they answered clearly stands,
 * the run carries on, and this is a note beside it; turning the whole answer
 * unclear over an extra name would throw away a decision they made perfectly
 * well and ask them the same thing again.
 *
 * The names are the reply's own words, already on the ticket where that person
 * wrote them, bounded and sanitised by the reading before they get here. They
 * are told, never recorded.
 */
export function formatAnswerNotOfferedComment(input: {
  /** The names the reply pointed at that the question never offered. */
  names: readonly string[];
  /** The repository keys the question DID offer. */
  askedKeys: readonly string[];
}): string {
  const them = input.names.length === 1 ? "it" : "them";
  return [
    `Your answer also named ${input.names.join(", ")}.`,
    `This question was only about ${input.askedKeys.join(", ")}, so ${them} ${input.names.length === 1 ? "was" : "were"} not acted on here and nothing about ${them} was recorded.`,
    `To add ${input.names.length === 1 ? "it" : "one of them"} to this work, select it in this work's repository list, through the work scope API or the work_scope.edit tool; a repository this deployment does not enable has to be enabled on the repositories screen first.`,
  ].join(" ");
}

/**
 * WHAT A PERSON WHO HANDED THE DECISION BACK IS TOLD.
 *
 * "whatever you think is best" asked us to choose, and we did, so this says
 * what we chose and whose choice it was: the workflow's, at their request. It
 * never says they chose, because they named nothing, and the record says the
 * same (origin `delegated`).
 *
 * WHAT IT DID NOT TAKE IS NOT LEFT OUT. A person who names three of five has
 * judged the other two, and `formatAnswerLeftOutComment` says so; a person who
 * hands the decision back has judged nothing, so the repositories we did not
 * take stay open. Saying "left out of this work" here would be claiming a
 * decision in their name. Open means the WORK may still take one if it needs
 * it, and that includes this very run: on production (AWP-247) the run's own
 * agent asked for the one left open three minutes after this note and got it,
 * so a note naming only "a later run" was not the whole truth. What it no
 * longer promises is a question, which nothing here can guarantee.
 *
 * ONE MESSAGE, AND ITS NUMBERS AGREE. It used to say a later run "may still
 * take it or ask about it" and then that "the next run may not ask about them
 * either", with "them" standing for one repository. Every pronoun follows the
 * count of the list it stands for.
 *
 * THE WAY TO CHANGE IT IS THE ONE THAT WORKS ON EVERY CHANNEL: the work's
 * repository list. The ticket route is named only to shut it, and only where
 * it is shut for a reason the sentence can name: a delegation mostly answers
 * the which-of-these question, raised because more than three repositories
 * were open, and there a path written in a comment brings nothing in
 * (`commentPathAfterAnUnrecordedAnswer`). A person answering on the ticket
 * would otherwise try the one thing that silently does not work.
 *
 * ENABLING IS MENTIONED ONLY WHERE IT IS TRUE, per repository, in the sentence
 * the run itself uses for it: a person whose repositories are all enabled has
 * no use for a condition that does not apply to them.
 */
export function formatAnswerDelegatedComment(input: {
  /** What the workflow took, in the order the question listed them. */
  taken: readonly string[];
  /** What the question listed and the workflow did not take, less anything a
   *  person had already decided on, which is theirs and not left open. */
  notTaken: readonly string[];
  /** Of the two lists above, the repositories this deployment's catalog does
   *  not enable. Empty on a deployment that never activated its catalog. */
  notEnabled: readonly string[];
  commentPath: UnrecordedAnswerCommentPath;
}): string {
  const { taken, notTaken } = input;
  const it = notTaken.length === 1 ? "it" : "them";
  // Of what is left open, only the part this deployment's catalog still
  // enables is one this run's agent or a later run could actually take: one
  // it does not enable stays left open too, but no run can use it until
  // somebody enables it, which is what the separate per-key sentence below
  // says. Claiming "may still take" for that one would be false.
  const usableLeftOpen = notTaken.filter((key) => !input.notEnabled.includes(key));
  const usableIt = usableLeftOpen.length === 1 ? "it" : "them";
  // Both empty only when a person had already selected or excluded every
  // repository the question listed (`repositoriesADelegationTakes` leaves
  // those alone), so there was nothing left to choose among.
  const opening =
    taken.length > 0
      ? `You asked the workflow to decide, so it chose ${taken.join(", ")} for this work${taken.length > 1 ? ", in the order the question listed them" : ""}.`
      : notTaken.length > 0
        ? `You asked the workflow to decide, and it continues without ${notTaken.join(", ")}, because this run cannot use ${it} as things stand.`
        : "You asked the workflow to decide, and every repository the question listed already carries a decision a person made on this work, so it changed none of them.";
  // Where it took nothing, what it left is what this run cannot use, so only
  // a later run may come back to it.
  const leftOpen =
    notTaken.length === 0
      ? undefined
      : taken.length > 0
        ? usableLeftOpen.length > 0
          ? `It left ${usableLeftOpen.join(", ")} open: nothing is recorded about ${usableIt}, so this run's agent or a later run may still take ${usableIt} if the work needs ${usableIt}.`
          : undefined
        : `Nothing is recorded about ${it}, so a later run may ask about ${it} again.`;
  const commentPathShut =
    input.commentPath === "too_many_open" && notTaken.length > 0
      ? `Writing ${notTaken.length === 1 ? "its path" : "their paths"} in a comment here does not bring ${it} in while this ticket names more than three repositories a run could still start from.`
      : undefined;
  return [
    opening,
    ...(leftOpen ? [leftOpen] : []),
    ...(commentPathShut ? [commentPathShut] : []),
    ...input.notEnabled.map(notEnabledOnTheRepositoriesPage),
    theWayToChangeTheChoice,
  ].join(" ");
}

/** Changing a choice the workflow made, which is selecting or removing, on the
 *  one surface that does both whatever the ticket says. */
const theWayToChangeTheChoice =
  "To change what this work uses, select or remove repositories in this work's repository list, through the work scope API or the work_scope.edit tool.";

/** A repository this deployment's catalog does not enable, in the words the run
 *  itself uses for it (`unopenableRemedy` in `engine/work-scope/context.ts`), so
 *  the person reads one story wherever they meet it. */
function notEnabledOnTheRepositoriesPage(key: string): string {
  return `${key} is not enabled on the Repositories page. Somebody with access to that page can enable it, and until then no run can use it.`;
}

/**
 * WHAT HAPPENED TO THE REPOSITORIES AN ANSWER NAMED THAT THE QUESTION NEVER
 * LISTED, now that such a name is looked up rather than only told back.
 *
 * Three outcomes, one sentence each, and every one of them is a fact rather
 * than a promise. A name the catalog holds and enables was added as their
 * choice. A name the catalog holds but does not enable is recorded as their
 * choice too (A5), and the run refuses it at start; the sentence is the one the
 * run itself uses for that repository (`unopenableRemedy` in
 * `engine/work-scope/context.ts`), so the person reads one story in two
 * places. A name that matches nothing this deployment holds recorded nothing,
 * which keeps an invented key harmless, and the list cannot take it either, so
 * the person is told to check the name or have it added to the catalog.
 */
export function formatAnswerAlsoNamedComment(input: {
  added: readonly string[];
  notEnabled: readonly string[];
  unmatched: readonly string[];
  /** Held here, and past what one answer records at once. */
  overLimit?: readonly string[];
}): string {
  const sentences: string[] = [];
  if (input.added.length > 0) {
    const plural = input.added.length > 1;
    sentences.push(
      `Your answer also named ${input.added.join(", ")}, which the question did not list; ${plural ? "they are" : "it is"} part of this work as your choice.`,
    );
  }
  for (const key of input.notEnabled) {
    sentences.push(
      `Your answer also named ${key}, which is recorded as your choice. ${notEnabledOnTheRepositoriesPage(key)}`,
    );
  }
  const overLimit = input.overLimit ?? [];
  // A NAME THAT MATCHED NOTHING CANNOT BE SELECTED. The work's repository list
  // refuses a key the catalog does not hold (`work_scope.edit` writes nothing
  // for it), so sending this person there spends their next attempt on a route
  // that fails (AWP-252 on production). What can be wrong is how the name was
  // written, which covers a bare word too: "web" is never resolved (A3), even
  // where the catalog holds github:acme/web. What can fix a name written right
  // is the catalog.
  if (input.unmatched.length > 0) {
    const one = input.unmatched.length === 1;
    sentences.push(
      `Your answer also named ${input.unmatched.join(", ")}, which could not be matched to a repository this deployment holds, so nothing about ${one ? "it" : "them"} was recorded.`,
      one
        ? "A repository is matched by its full path, such as github:acme/app: check how it was written, and if it is right, it has to be added to this deployment's catalog on the repositories screen before this work can use it."
        : "A repository is matched by its full path, such as github:acme/app: check how they were written, and if a name is right, that repository has to be added to this deployment's catalog on the repositories screen before this work can use it.",
    );
  }
  // Held here and only past what one answer records, so the list does take it.
  if (overLimit.length > 0) {
    const one = overLimit.length === 1;
    sentences.push(
      `Your answer also named ${overLimit.join(", ")}, past the eight repositories one answer records at once, so nothing about ${one ? "it" : "them"} was recorded.`,
      `To add ${one ? "it" : "one of them"} to this work, select it in this work's repository list, through the work scope API or the work_scope.edit tool; a repository this deployment does not enable has to be enabled on the repositories screen first.`,
    );
  }
  return sentences.join(" ");
}

/**
 * WHAT AN ANSWER NOBODY COULD READ IS TOLD, and it is the only sentence on this
 * path that asks for something rather than reporting something.
 *
 * Every other sentence here explains a decision that has already been made.
 * This one is said while nothing has been decided: the reading could not settle
 * what the words meant, so nothing was recorded, the run is still parked on this
 * very question, and the next reply is read against it. Three things have to be
 * in it and each is a defect if it is missing.
 *
 * WHAT WE READ, when there is anything to say. A person who is told only "I
 * could not read that" has no idea which half of their sentence was the problem
 * and types a variant of the same thing; a person who is shown our best reading
 * corrects it in one line. It is offered as our reading, never as a decision,
 * because it is not one.
 *
 * THAT NOTHING HAPPENED. This is the sentence's real work. An answer that
 * vanishes silently is how somebody concludes the system took their word for it
 * and moves on, and the question then expires with the run still waiting.
 *
 * THE ONE REPLY THAT ENDS IT, spelled in the vocabulary of the question they
 * were actually asked: a yes or a no under a question about one repository, and
 * the names or "none of these" under a list. Never a general invitation to
 * rephrase, which is what the phrase list used to offer and what sent people
 * round the same loop.
 *
 * AND WHERE THE TICKET WAITS, only when this answer's delivery moved it there.
 * A person who replied and moved the ticket into the AI column finds it back in
 * the backlog, and without a word about why that reads as the system losing
 * their answer. Said only after the move happened, so it never claims one.
 */
/**
 * The reply that decides a question offering candidates, in the vocabulary of
 * the question the person is actually looking at.
 *
 * ONE SENTENCE FOR BOTH READERS, which is why it lives here rather than inside
 * either of them. The question teaches it before anybody answers, and the
 * comment that could not read an answer teaches it again; two copies drift, and
 * the drift lands on the person who did what the first one said.
 *
 * Production, AWP-263 on 2026-09-20. The candidate question ended "Reply with
 * full provider-scoped paths (for example github:acme/app)", somebody wrote a
 * full provider-scoped path, and it was refused with "Reply yes to use
 * gitlab:... or no to continue without it": the path named a repository the
 * question had not listed, and a reading may never widen what was asked. The
 * refusal was right. The question had invited an answer no reader takes.
 */
export function replyThatDecidesCandidates(input: {
  /** Whether the question offered a list or exactly one repository. */
  shape: "list" | "one";
  /** The repository keys the question offered, in the order it listed them. */
  askedKeys: readonly string[];
}): string {
  return input.shape === "one" && input.askedKeys.length === 1
    ? `Reply "yes" to use ${input.askedKeys[0]} in this work, or "no" to continue without it.`
    : [
        `Reply with the repositories this work should use, from ${input.askedKeys.join(", ")},`,
        `or "none of these" to use none of them.`,
      ].join(" ");
}

export function formatAnswerUnreadableComment(input: {
  /** Our best reading of what they may have meant, absent when even that would
   *  be a guess. */
  paraphrase?: string;
  /** Whether the question offered a list or exactly one repository. */
  shape: "list" | "one";
  /** The repository keys the question offered, in the order it listed them. */
  askedKeys: readonly string[];
  /** The columns, present only when the ticket was just moved back to the
   *  backlog to wait for the reply. */
  waiting?: { backlogColumnName: string; aiColumnName: string };
}): string {
  const opening = input.paraphrase
    ? `I could not be sure what that answer decided. My best reading is: ${input.paraphrase}`
    : "I could not tell what that answer decided about the repositories.";
  const ask = replyThatDecidesCandidates(input);
  const waiting = input.waiting
    ? `This ticket is back in the "${input.waiting.backlogColumnName}" column while the question waits. Reply in a comment here and move it to the "${input.waiting.aiColumnName}" column again, or answer in the dashboard.`
    : undefined;
  return [
    opening,
    "Nothing has been recorded, and this question is still open: the run is waiting on it, and the next reply is read against it.",
    ask,
    ...(waiting ? [waiting] : []),
  ].join("\n\n");
}

/**
 * What an answer that NAMED repositories left out, for the person who wrote it.
 *
 * The same binding as a decline and, until this existed, the silent half of it:
 * a question lists four repositories, somebody names one, and the other three
 * are left out of this work with no later run taking them on its own (C11). A
 * bare "no" on the dashboard got a full sentence about exactly that, and the
 * person who answered it by naming what they wanted got nothing at all, which
 * taught the more careful answer less.
 *
 * It says what was left out rather than what was recorded: what they named is
 * in front of them already, they just typed it.
 */
export function formatAnswerLeftOutComment(repositoryKeys: readonly string[]): string {
  const them = repositoryKeys.length === 1 ? "it" : "them";
  return [
    `Your answer named other repositories, so ${repositoryKeys.join(", ")}, which the question also listed, ${repositoryKeys.length === 1 ? "is" : "are"} left out of this work, and no later run takes ${them} on its own.`,
    theWayBackIntoTheWork(repositoryKeys.length),
  ].join(" ");
}

/** How a repository the work already holds leaves it, said per reason because
 *  the reasons do not leave the same way. An exclusion is a person's own entry,
 *  which no later reading of the ticket, trigger policy or selection overrides
 *  (`blockingReason` in `engine/work-scope/decide.ts`). A workflow-owned branch
 *  is taken whatever the record says, so that the pull request on it is never
 *  stranded (`selectRepositoriesFromMetadata`), and the sentence promises
 *  nothing about excluding one. */
const keptStayUntilTheirReasonGoes =
  "A repository that is already part of this work stays until the reason it is there goes: an exclusion in this work's repository list, through the work scope API or the work_scope.edit tool, keeps out one the ticket's text, a trigger policy or a person's selection brought in, and one a workflow-owned branch brought in stays while this work owns that branch.";

/** Choosing among the repositories the question offers, which is only done by
 *  answering it, the next time it is asked. */
const NAME_ONLY_THE_ONES_TO_USE =
  'The next time the question is asked, name only the repositories to use, or answer "none".';

/** The word that means every repository a question lists, whatever it lists, so
 *  a person whose counting word disagreed with the list has one that cannot.
 *  It is the vocabulary the reader already accepts (`ALL_OF_THEM` in
 *  `engine/work-scope/answer.ts`), and nothing here teaches a word that reader
 *  would not take. */
const EVERY_ONE_THE_QUESTION_LISTS =
  'The next time the question is asked, answer "all" to use every repository it lists, or name the ones to use.';

/** The half of the sentence that is true of every answer the record kept
 *  nothing from, whatever the question asked for. */
const ASKED_AGAIN_ON_A_LATER_RUN =
  "It means the same question may be asked again on a later run.";

/** The way out for a name this deployment does not hold, which is the one case
 *  where writing the path out is not one. Both halves are routes that exist:
 *  the repositories screen (`apps/dashboard/app/(cockpit)/repositories`) is
 *  where a repository is added or enabled, and the question comes back on a
 *  later run, which is where naming it records it. */
const checkTheNameOrAddIt =
  "Check the name: if that repository should be here, somebody with access to the repositories screen can add or enable it, and naming it the next time the question is asked records it then.";

/** The way out when nothing the question listed is a repository a written path
 *  could reach. Two halves, like `checkTheNameOrAddIt`, and the same two
 *  routes, minus the name: there is nothing for this person to check, because
 *  WE put those repositories in front of them. What stands between them and
 *  using one is the deployment's own repository list, so that is what the
 *  sentence names, exactly as `catalogCannotServeNote`
 *  (`engine/work-scope/context.ts`) names it for the same repositories on the
 *  other channel. "The repositories screen" is the name this file has used
 *  since `checkTheNameOrAddIt`, and one name for one place is worth more here
 *  than matching the other file's word for it. */
function onlyTheCatalogCanOpenThese(one: boolean): string {
  return one
    ? "Writing its path in a comment here reaches nothing, because the catalog cannot serve it as things stand: somebody with access to the repositories screen has to enable it there before any run can use it, and naming it the next time the question is asked records it then."
    : "Writing one of their paths in a comment here reaches nothing, because the catalog cannot serve them as things stand: somebody with access to the repositories screen has to enable them there before any run can use one, and naming one the next time the question is asked records it then.";
}

/** The way out when the question listed more than three repositories.
 *
 *  It said the path reaches the next run and is asked about there instead. The
 *  first half was true and the second was a promise this surface cannot keep:
 *  a run asks which of them to start from only while nothing on this work has
 *  answered that question, and once something has, a path written in a comment
 *  is neither taken nor asked about. So the sentence now says the outcome the
 *  person can count on, that the comment brings nothing in, and stops short of
 *  promising the question that may never come. Two routes do settle it: naming
 *  one when the question comes back, which records it, and selecting it in the
 *  work's repository list, which the next run starts from whatever the ticket
 *  names. */
const COMMENT_PATH_SHUT_WHILE_TOO_MANY_OPEN =
  "Writing one of their paths in a comment here brings nothing into this work while this ticket names more than three repositories a run could still start from, and the next run may not ask about them either.";
const tooManyNamedForAComment = `${COMMENT_PATH_SHUT_WHILE_TOO_MANY_OPEN} To use one of them, name it the next time the question is asked, or select it in this work's repository list through the work scope API or the work_scope.edit tool, which the next run starts from.`;

/** The way out where nothing on this surface can prove a written path is
 *  taken: a question raised mid run says nothing about how many repositories
 *  the ticket names, and a path written there can tip the next run into asking
 *  instead. Both routes named here work whatever the ticket says. */
function onlyTheRecordIsProven(one: boolean): string {
  return `To use ${one ? "it" : "one of them"} after all, select it in this work's repository list through the work scope API or the work_scope.edit tool, which the next run starts from, or name it the next time the question is asked.`;
}

/** What to do differently when it is asked again, for the reasons that are
 *  about HOW the answer arrived rather than what it said. */
const ONE_PERSON_ANSWERING_IT =
  "An answer written by one person in a single comment is the one that gets recorded.";

/**
 * The nudge for a ticket whose comments we could not read all the way back to
 * the question.
 *
 * Silence is the one answer that must not be given here. The run is waiting, we
 * cannot prove nobody has answered, and saying nothing teaches the person that
 * the system is broken; nudging with the ordinary sentence would instead tell
 * somebody who HAS answered that they have not. So it says what is true: the
 * question is open, this ticket is hard for us to read, and the dashboard is
 * the way through that does not depend on reading it.
 */
export function formatClarificationUnreadableNudgeComment(input: {
  dashboardUrl: string;
  aiColumnName: string;
}): string {
  return [
    `The AI workflow is ${CLARIFICATION_NUDGE_MARKER} on this ticket.`,
    "This ticket has more comments than the AI workflow can read back through, so an answer posted here may not be seen.",
    `Answer in the dashboard (${input.dashboardUrl}), or reply in a comment here and move the ticket back to the "${input.aiColumnName}" column.`,
  ].join("\n");
}
