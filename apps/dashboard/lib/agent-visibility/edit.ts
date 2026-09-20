/**
 * Correcting a subject's repository record from the ticket page.
 *
 * The worker's `PATCH /api/v1/work-scope` decides everything: which actions
 * exist, who may write, and whether the version a person read is still the one
 * in force. This module holds what the screen needs around that call: the
 * change it is about to send, the sentence saying what that change will do,
 * the sentence for what the worker answered, and the change that puts the
 * record back.
 *
 * NOTHING HERE DECIDES A REFUSAL. Every failure is the worker's, in the
 * worker's words where it has any: it answers 401 and 403 with the bare words
 * "Unauthorized" and "Forbidden" (`services/auth/request-context.ts`), which
 * are a status code spelled out rather than something a person can act on, so
 * those two get a sentence here and the worker's word is shown only when it is
 * more than that.
 */
import type { AgentBriefingWorkScopeEntry } from "@shared/agent-visibility";
import { WORK_SCOPE_RATIONALE_MAX_LENGTH } from "@shared/contracts";

import { formatMoment } from "./format";
import { actorLabel, entryStateLabel } from "./wording";

/** The three the endpoint takes. `remove` deletes the entry, which is the
 *  undo of both of the others: it lets a later run decide again, where
 *  `exclude` is the sticky one (`engine/work-scope/decide.ts`). */
export type EditAction = "select" | "exclude" | "remove";

export type RecordEntry = AgentBriefingWorkScopeEntry;

/** One change, and everything needed to explain it and to take it back: the
 *  entry as it stood, and the record version it was decided against. */
export interface EditIntent {
  repositoryKey: string;
  action: EditAction;
  before: RecordEntry | null;
  version: number;
}

/** What is written when a person adds nothing of their own. The trail carries
 *  their name and the time either way; this says which surface they used.
 *
 *  IT HAS TO SAY THAT NOBODY WROTE IT. This sentence is rendered in the very
 *  slot a run's own reason is rendered in, after the same colon, so anything
 *  that reads like a reason reads as the person's reason. "Corrected on the
 *  dashboard." did, and somebody reading the record months later had no way
 *  to tell it from a sentence that was typed. */
export const DEFAULT_RATIONALE = "No reason given. Changed from the Repositories panel.";

/** The bound the endpoint puts on a rationale, from the write contract itself
 *  so the field cannot take more than the record will keep. */
export const RATIONALE_MAX_LENGTH = WORK_SCOPE_RATIONALE_MAX_LENGTH;

/**
 * The actions worth offering for an entry, in the order they are shown.
 *
 * A state is never offered as a change to itself, and `remove` is offered only
 * where there is an entry to remove. A repository with no entry can be both
 * selected and excluded: a question that offered three repositories to someone
 * who meant one leaves two they want ruled out, and `exclude` is the sticky
 * one that stops a later question offering them again.
 */
export function actionsFor(entry: RecordEntry | null): EditAction[] {
  if (entry === null) return ["select", "exclude"];
  const actions: EditAction[] = [];
  if (entry.state !== "selected") actions.push("select");
  if (entry.state !== "excluded") actions.push("exclude");
  actions.push("remove");
  return actions;
}

export function actionLabel(action: EditAction): string {
  const labels: Record<EditAction, string> = {
    select: "Select",
    exclude: "Exclude",
    remove: "Remove from the record",
  };
  return labels[action];
}

/** The word on the button that sends it. Never the same word as the one that
 *  opened the confirmation, so that tapping it is visibly a second step. */
export function confirmLabel(action: EditAction): string {
  const labels: Record<EditAction, string> = {
    select: "Yes, select it",
    exclude: "Yes, exclude it",
    remove: "Yes, remove it",
  };
  return labels[action];
}

/** What the change will do, before it happens. */
export function willHappenSentence(intent: EditIntent): string {
  switch (intent.action) {
    case "select":
      return `${intent.repositoryKey} becomes a repository this ticket's work may touch.`;
    case "exclude":
      return `${intent.repositoryKey} becomes a repository this ticket's work will not touch, and a later question will not offer it again.`;
    case "remove":
      return `${intent.repositoryKey} leaves the record: neither chosen nor refused, as if nobody had decided about it. A later run may ask about it again.`;
  }
}

/** The second line of a confirmation: whose decision this becomes, and what it
 *  does not do. The endpoint writes the record and touches nothing else, so a
 *  run in flight is not stopped, restarted or answered by it. */
export const RECORDED_AS_YOU = "It is recorded as your decision, with your name and the time.";
export const NOT_A_RUN_ACTION = "It changes the record only. Nothing running is stopped or restarted by it.";
export const NOT_AN_ANSWER =
  "A question is still waiting for an answer. This does not answer it, and the run stays parked until someone does.";

/**
 * What happened, read from the record the worker sent back rather than from
 * what was asked for. A `remove` of an entry another person removed first is
 * applied and changes nothing, and saying "Removed" there would be a sentence
 * about the request, not about the record.
 */
export function appliedSentence(repositoryKey: string, after: RecordEntry | null): string {
  if (after === null) return `${repositoryKey} is not in the record.`;
  return `${repositoryKey} is now: ${entryStateLabel(after).toLowerCase()}, ${actorLabel(after.decidedBy)}, ${formatMoment(
    after.decidedAt,
  )}.`;
}

/**
 * The change that puts the record back where it was, or null when nothing can.
 *
 * `unavailable` is a state only a run records (it means the catalog could not
 * serve the repository), so an entry that held it cannot be written back by a
 * person and is not offered as an undo rather than being undone into something
 * else. `version` is the version the edit produced: an undo is refused, like
 * any other write, when the record has moved on since.
 */
export function undoOf(original: EditIntent, after: RecordEntry | null, versionAfter: number): EditIntent | null {
  const back = { repositoryKey: original.repositoryKey, before: after, version: versionAfter };
  const before = original.before;
  if (before === null) return { ...back, action: "remove" };
  if (before.state === "selected") return { ...back, action: "select" };
  if (before.state === "excluded") return { ...back, action: "exclude" };
  return null;
}

/** What an undo will do, said as one correction rather than as a new decision.
 *  Takes the change being taken back, because the state to go back to is the
 *  one that change was decided against. */
export function undoSentence(original: EditIntent): string {
  const before = original.before;
  if (before === null) {
    return `${original.repositoryKey} goes back to not being in the record, where it was before your change.`;
  }
  return `${original.repositoryKey} goes back to ${entryStateLabel(
    before,
  ).toLowerCase()}, where it was before your change. Your name goes on it, because the record keeps who decided last.`;
}

/**
 * The repositories a question put in front of a person that the record holds
 * no entry for. They are the ones somebody may have meant and nobody recorded,
 * and they are already on this screen, so offering them costs no request and
 * invents no catalog picker.
 */
/** What a repository nobody has decided about can become here. Excluding one
 *  is a decision in its own right, and the worker's edit path writes it
 *  whether or not an entry exists (`engine/work-scope/decide.ts`).
 *
 *  SAID ONCE, ABOVE THE LIST. It is the same sentence for every repository in
 *  it, so per row it was the same paragraph two or three times over, and a
 *  person scanning for which repositories are undecided read the explanation
 *  instead of the keys. Worded for one or many, because the list can hold
 *  either. */
export const OFFERED_LINE =
  "Nothing has been decided about the repositories below. Selecting one puts it in the record; excluding it keeps a later question from offering it again.";

export function offeredNotInRecord(
  rounds: readonly { question: { offered: readonly { key: string }[] | null } }[],
  entries: readonly { repositoryKey: string }[],
): string[] {
  const recorded = new Set(entries.map((entry) => entry.repositoryKey));
  const keys: string[] = [];
  for (const round of rounds) {
    for (const offered of round.question.offered ?? []) {
      if (!recorded.has(offered.key) && !keys.includes(offered.key)) keys.push(offered.key);
    }
  }
  return keys;
}

/** The record changed under a confirmation that was already open. Nothing was
 *  sent: the version on the screen is no longer the one it was opened on. */
export function movedWhileDeciding(readVersion: number, nowVersion: number): { title: string; body: string } {
  return {
    title: "The record changed while you were deciding",
    body: `Nothing was sent. This page now shows version ${nowVersion}, not the version ${readVersion} you tapped on: a run or another person wrote in between. Read what it says now and make the change again if it is still what you want.`,
  };
}

/* ── What the worker refused, and what a person can do about it ─────────── */

export type EditFailure =
  /** The session has ended. */
  | { kind: "unauthorized" }
  /** Signed in, not a member of this workspace. `message` only when the worker
   *  said more than the bare status word. */
  | { kind: "forbidden"; message: string | null }
  /** The worker's own sentence: a repository the catalog does not enable, a
   *  subject that carries no record, a body it will not take. */
  | { kind: "refused"; message: string }
  /** The record moved between the read and the write. Never applied. */
  | { kind: "conflict"; latestVersion: number | null }
  /** This worker does not serve edits yet. */
  | { kind: "absent" }
  /** Applied, and the record it answered with cannot be read here. */
  | { kind: "unreadable"; message: string }
  /** Nobody can say whether it was applied: the answer never arrived. */
  | { kind: "unknown"; status: number | null; message: string };

/** The words a bare status line carries, which say nothing a person can use. */
const STATUS_WORDS = new Set(["unauthorized", "forbidden", "bad request", "not found", "conflict", "request failed"]);

function saidMoreThanTheStatus(message: string): string | null {
  const trimmed = message.trim();
  return trimmed === "" || STATUS_WORDS.has(trimmed.toLowerCase()) ? null : trimmed;
}

function conflictVersion(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const latest = (body as { latestVersion?: unknown }).latestVersion;
  return typeof latest === "number" && Number.isInteger(latest) && latest >= 0 ? latest : null;
}

/** The failure of one edit, from what the request layer came back with. */
export function readEditFailure(result: { status: number; error: unknown; errorMessage: string }): EditFailure {
  if (result.status === 401) return { kind: "unauthorized" };
  if (result.status === 403) return { kind: "forbidden", message: saidMoreThanTheStatus(result.errorMessage) };
  if (result.status === 409) return { kind: "conflict", latestVersion: conflictVersion(result.error) };
  if (result.status === 404) return { kind: "absent" };
  if (result.status >= 400 && result.status < 500) {
    const message = saidMoreThanTheStatus(result.errorMessage);
    return message === null
      ? { kind: "unknown", status: result.status, message: result.errorMessage }
      : { kind: "refused", message };
  }
  return { kind: "unknown", status: result.status, message: result.errorMessage };
}

export interface EditFailureNotice {
  title: string;
  body: string;
  /** `reload`: the record on the screen is not the record. `signin`: the
   *  session ended. `none`: nothing on this screen helps. */
  action: "reload" | "signin" | "none";
}

/**
 * What to tell a person about a refused edit. Every one of these says whether
 * the record changed, because the question a person has after a red line is
 * "did it go through".
 */
export function editFailureNotice(failure: EditFailure, version: number): EditFailureNotice {
  switch (failure.kind) {
    case "unauthorized":
      return {
        title: "Your session has ended",
        body: "Nothing was changed. Sign in again, then make the change.",
        action: "signin",
      };
    case "forbidden":
      return {
        title: "The worker did not accept you as a member here",
        body: `Nothing was changed. Editing this record is open to every member of the workspace, so an owner or an admin adding you is what unblocks it.${
          failure.message === null ? "" : ` The worker said: ${failure.message}`
        }`,
        action: "none",
      };
    case "refused":
      return { title: "The change was refused", body: `Nothing was changed. ${failure.message}`, action: "none" };
    case "conflict":
      return {
        title: "The record moved while this page was open",
        body: `Nothing was changed. You were looking at version ${version}${
          failure.latestVersion === null ? "" : `, and the record is at version ${failure.latestVersion}`
        }: a run or another person wrote in between. Read the record again and decide against what it says now.`,
        action: "reload",
      };
    case "absent":
      return {
        title: "This worker does not take edits yet",
        body: "Nothing was changed. The worker and this dashboard deploy separately, and the one answering does not serve this route.",
        action: "none",
      };
    case "unreadable":
      return {
        title: "The change was made, and the answer could not be read",
        body: `The worker accepted it and sent back a record this dashboard cannot read: ${failure.message} Read the record again to see where it stands.`,
        action: "reload",
      };
    case "unknown":
      return {
        title: "The worker did not answer",
        body: `Whether the change was applied cannot be told from here${
          failure.status === null ? "" : ` (${failure.status})`
        }: ${failure.message} Read the record again to see where it stands.`,
        action: "reload",
      };
  }
}
