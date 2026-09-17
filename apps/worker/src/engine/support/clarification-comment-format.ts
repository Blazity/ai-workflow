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
 * Trace posted to the ticket when a clarification is answered somewhere other
 * than the ticket itself, which today means the dashboard. Without it the public
 * questions comment ends in silence: the ticket shows a question, then a status
 * change, and nothing that explains what unblocked the run. The Jira comment
 * path needs no trace, because the human's own comment already is one and this
 * would echo it back at them.
 *
 * The answer is human-authored, not agent-authored, and goes back into the
 * ticket that same human is invited to comment on, so it is published verbatim:
 * scrubbing here would edit a person's own words. Its length is already bounded
 * by MAX_ANSWER_LENGTH where the answer enters.
 */
export function formatClarificationAnswerComment(input: {
  answeredByLabel: string;
  answer: string;
}): string {
  return [
    `${input.answeredByLabel} answered the clarification in the dashboard; the run is resuming.`,
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
 * leaves out only our own). And a refusal has no such route at all: nothing
 * written on a ticket records "none", so the only honest thing to say about
 * declining is that the question comes back and answering it then records it.
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
 * `question.listedRepositories` is what they had in front of them, and it
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
    /** Did the question put repository keys in front of the person at all? */
    listedRepositories: boolean;
    /** Could a later run's path matcher pick those repositories up out of a
     *  comment? Read only where `listedRepositories` is true. */
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
  const nowThisRun =
    reason === "no_words" && question.listedRepositories
      ? "Your answer reached the run, which is continuing without the repositories the question asked about." +
        " Nothing was recorded about them, so a later run may use them and may ask about them again."
      : "Your answer reached the run, which is continuing.";

  // The route that works, written from what the next run actually reads. The
  // middle branch is the one the run itself can close: it listed repositories,
  // and none of them is one a written path could reach.
  const namingWorks = question.listedRepositories
    ? question.aLaterRunCanPickThemUp
      ? question.commentPath === "too_many_open"
        ? tooManyNamedForAComment
        : onlyTheRecordIsProven
      : onlyTheCatalogCanOpenThese
    : "Write the full path of the repository this work should use in a comment here, for example github:acme/app, and the next run reads this ticket and picks it up.";
  // The route that does not exist, said plainly instead of implied. Only worth
  // saying where the question offered repositories to decline.
  const decliningHasNoShortcut =
    'Nothing written on this ticket can record a refusal, so to leave them out, answer "none" the next time the question is asked.';
  const next: Record<AnswerNotRecordedReason, string> = {
    several_authors: `${ASKED_AGAIN_ON_A_LATER_RUN} ${ONE_PERSON_ANSWERING_IT} ${namingWorks}`,
    evidence_gone: `${ASKED_AGAIN_ON_A_LATER_RUN} ${ONE_PERSON_ANSWERING_IT} ${namingWorks}`,
    uncounted: `${ASKED_AGAIN_ON_A_LATER_RUN} ${ONE_PERSON_ANSWERING_IT} ${namingWorks}`,
    unaddressed_refusal: `${ASKED_AGAIN_ON_A_LATER_RUN} ${decliningHasNoShortcut} ${namingWorks}`,
    no_repository_named: question.listedRepositories
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
  };
  return [nowThisRun, ANSWER_NOT_RECORDED_WHY[reason], next[reason]].join("\n\n");
}

/**
 * What a DECLINE recorded, for the channel that took it.
 *
 * A bare "no" typed into the dashboard's box or sent through
 * `runs_answer_clarification` is an answer to the question in front of that
 * person, so it declines every repository the question listed: one entry each,
 * permanent, in their name. Those two channels used to say nothing at all about
 * it. The screen said "answered" and the rule lived in an MCP tool description
 * that no human ever reads, so the most consequential thing a one word answer
 * can do was also the least visible.
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
export function formatAnswerDeclinedComment(repositoryKeys: readonly string[]): string {
  const them = repositoryKeys.length === 1 ? "it" : "them";
  return [
    `Your answer was read as declining ${repositoryKeys.join(", ")}, which the question listed, so this work is recorded as leaving ${them} out.`,
    `To bring ${repositoryKeys.length === 1 ? "it" : "one of them"} back, select it in this work's repository list, through the work scope API or the work_scope.edit tool; a repository this deployment does not enable has to be enabled on the repositories screen first, or that selection is refused.`,
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
const onlyTheCatalogCanOpenThese =
  "Writing one of their paths in a comment here reaches nothing, because the catalog cannot serve them as things stand: somebody with access to the repositories screen has to enable them there before any run can use one, and naming one the next time the question is asked records it then.";

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
const tooManyNamedForAComment =
  "Writing one of their paths in a comment here brings nothing into this work while this ticket names more than three repositories a run could still start from, and the next run may not ask about them either. To use one of them, name it the next time the question is asked, or select it in this work's repository list through the work scope API or the work_scope.edit tool, which the next run starts from.";

/** The way out where nothing on this surface can prove a written path is
 *  taken: a question raised mid run says nothing about how many repositories
 *  the ticket names, and a path written there can tip the next run into asking
 *  instead. Both routes named here work whatever the ticket says. */
const onlyTheRecordIsProven =
  "To use one of them after all, select it in this work's repository list through the work scope API or the work_scope.edit tool, which the next run starts from, or name it the next time the question is asked.";

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
