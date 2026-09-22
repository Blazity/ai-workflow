"use client";

/**
 * The repository record, and the controls that correct it.
 *
 * Who this is for: the person whose answer in Jira was read as something they
 * did not mean. They are often not an engineer, frequently on a phone, and
 * usually in a hurry because a run is parked on them. So: two taps to change
 * one repository (the action, then the confirmation that says what it will
 * do), nothing optimistic, and every refusal in words that name the way on.
 *
 * NOTHING HERE DECIDES WHO MAY WRITE. The controls are offered to everybody
 * who can read the panel, the worker's `PATCH /api/v1/work-scope` refuses what
 * it refuses, and the refusal is what a person sees. Guessing here would mean
 * hiding a control from someone the worker would have accepted.
 */
import React from "react";

import { Button, CkChip, Input } from "@/components/ui";
import { apiClient } from "@/lib/api/client";
import { readWorkScopeEdit, type WorkScopeEditRead, type WorkScopeRead } from "@/lib/agent-visibility/contract";
import {
  DEFAULT_RATIONALE,
  NOT_AN_ANSWER,
  NOT_A_RUN_ACTION,
  OFFERED_LINE,
  RATIONALE_MAX_LENGTH,
  RECORDED_AS_YOU,
  actionLabel,
  actionsFor,
  appliedSentence,
  confirmLabel,
  editFailureNotice,
  movedWhileDeciding,
  readEditFailure,
  undoOf,
  undoSentence,
  willHappenSentence,
  type EditFailure,
  type EditIntent,
  type RecordEntry,
} from "@/lib/agent-visibility/edit";
import { formatMoment } from "@/lib/agent-visibility/format";
import { actorLabel, entryOriginLabel, entryStateLabel, entryStateTone } from "@/lib/agent-visibility/wording";

import { Notice } from "./notices";

/** A confirmation waiting for a tap. `undoing` is the change it takes back,
 *  which is what the sentence is about when there is one. */
interface Pending {
  intent: EditIntent;
  undoing: EditIntent | null;
}

type Outcome =
  | {
      kind: "applied";
      sentence: string;
      /** The change that puts it back, with the change it takes back. Null
       *  when this outcome is itself an undo, or when nothing can restore the
       *  state that was there (only a run records `unavailable`). */
      undo: { intent: EditIntent; undoing: EditIntent } | null;
      wasUndo: boolean;
    }
  | { kind: "failed"; repositoryKey: string; failure: EditFailure; version: number };

function entryOf(record: { entries: readonly RecordEntry[] }, repositoryKey: string): RecordEntry | null {
  return record.entries.find((entry) => entry.repositoryKey === repositoryKey) ?? null;
}

function Actions({
  entry,
  repositoryKey,
  disabled,
  onPick,
}: {
  entry: RecordEntry | null;
  repositoryKey: string;
  disabled: boolean;
  onPick: (action: EditIntent["action"]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 pt-0.5">
      {actionsFor(entry).map((action) => (
        <Button
          key={action}
          variant="secondary"
          size="md"
          disabled={disabled}
          onClick={() => onPick(action)}
          aria-label={`${actionLabel(action)}: ${repositoryKey}`}
        >
          {actionLabel(action)}
        </Button>
      ))}
    </div>
  );
}

function Confirmation({
  pending,
  questionWaiting,
  sending,
  reason,
  onReason,
  onConfirm,
  onCancel,
}: {
  pending: Pending;
  questionWaiting: boolean;
  sending: boolean;
  reason: string | null;
  onReason: (value: string | null) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const sentence = pending.undoing ? undoSentence(pending.undoing) : willHappenSentence(pending.intent);
  return (
    <div
      role="group"
      aria-label={`Confirm: ${actionLabel(pending.intent.action)} ${pending.intent.repositoryKey}`}
      className="mt-1.5 flex flex-col gap-2 rounded-[3px] border border-mariner-200 bg-mariner-100 px-3 py-2.5"
    >
      <p className="m-0 font-body text-[13px] leading-[1.5] text-coal">{sentence}</p>
      <p className="m-0 font-body text-[12px] leading-[1.5] text-neutral-800">
        {RECORDED_AS_YOU} {NOT_A_RUN_ACTION}
      </p>
      {questionWaiting ? <p className="m-0 font-body text-[12px] leading-[1.5] text-neutral-800">{NOT_AN_ANSWER}</p> : null}
      {reason === null ? (
        <div>
          <Button variant="text" size="sm" className="font-body text-[12px] underline" onClick={() => onReason("")}>
            Add a reason
          </Button>
        </div>
      ) : (
        <Input
          size="sm"
          value={reason}
          maxLength={RATIONALE_MAX_LENGTH}
          disabled={sending}
          aria-label="Why you are making this change"
          placeholder="Why, in your own words (optional)"
          onChange={(event) => onReason(event.target.value)}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="md" loading={sending} onClick={onConfirm}>
          {confirmLabel(pending.intent.action)}
        </Button>
        <Button variant="secondary" size="md" disabled={sending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function OutcomeNotice({
  outcome,
  version,
  onUndo,
  onReload,
  onDismiss,
}: {
  outcome: Outcome;
  version: number;
  onUndo: (undo: { intent: EditIntent; undoing: EditIntent }) => void;
  onReload: () => void;
  onDismiss: () => void;
}) {
  if (outcome.kind === "applied") {
    const undo = outcome.undo;
    return (
      <Notice
        role="status"
        action={
          <>
            {undo ? (
              <Button variant="secondary" size="sm" onClick={() => onUndo(undo)}>
                Undo this change
              </Button>
            ) : null}
            <Button variant="text" size="sm" className="font-body text-[12px] underline" onClick={onDismiss}>
              Dismiss
            </Button>
          </>
        }
      >
        <span className="font-semibold">{outcome.wasUndo ? "Put back." : "Recorded."}</span> {outcome.sentence}
      </Notice>
    );
  }
  const notice = editFailureNotice(outcome.failure, outcome.version);
  return (
    <Notice
      tone="failure"
      role="alert"
      title={notice.title}
      action={
        notice.action === "signin" ? (
          <Button variant="secondary" size="sm" href="/login">
            Sign in again
          </Button>
        ) : notice.action === "reload" ? (
          <Button variant="secondary" size="sm" onClick={onReload}>
            Read the record again
          </Button>
        ) : (
          <Button variant="text" size="sm" className="font-body text-[12px] underline" onClick={onDismiss}>
            Dismiss
          </Button>
        )
      }
    >
      {notice.body}
      {outcome.failure.kind === "conflict" ? ` This page is at version ${version}.` : ""}
    </Notice>
  );
}

/**
 * The record with its controls. `onRecord` hands the panel the record the
 * worker answered with, so what is on the screen after a change is the
 * worker's own answer and not a guess made here.
 */
export function RecordEditor({
  record,
  offered,
  questionWaiting,
  onRecord,
  onReload,
}: {
  record: WorkScopeRead;
  /** Repositories a question offered that the record has no entry for. */
  offered: readonly string[];
  questionWaiting: boolean;
  onRecord: (scope: WorkScopeEditRead) => void;
  onReload: () => void;
}) {
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [reason, setReason] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);

  const open = (repositoryKey: string, action: EditIntent["action"], undoing: EditIntent | null = null) => {
    setReason(null);
    setOutcome(null);
    setPending({
      intent: { repositoryKey, action, before: entryOf(record, repositoryKey), version: record.version },
      undoing,
    });
  };

  const send = async (pending_: Pending) => {
    const { intent, undoing } = pending_;
    const words = reason?.trim();
    setSending(true);
    let result;
    try {
      result = await apiClient.workScope.edit({
        subjectKey: record.subjectKey,
        expectedVersion: intent.version,
        changes: [
          {
            repositoryKey: intent.repositoryKey,
            action: intent.action,
            rationale: words ? words : DEFAULT_RATIONALE,
          },
        ],
      });
    } catch {
      setSending(false);
      setOutcome({
        kind: "failed",
        repositoryKey: intent.repositoryKey,
        version: intent.version,
        failure: { kind: "unknown", status: null, message: "The dashboard could not reach the worker." },
      });
      return;
    }
    setSending(false);
    setPending(null);
    if (!result.ok) {
      setOutcome({
        kind: "failed",
        repositoryKey: intent.repositoryKey,
        version: intent.version,
        failure: readEditFailure(result),
      });
      return;
    }
    const read = readWorkScopeEdit(result.data);
    if (!read.ok) {
      setOutcome({
        kind: "failed",
        repositoryKey: intent.repositoryKey,
        version: intent.version,
        failure: { kind: "unreadable", message: read.message },
      });
      return;
    }
    const after = entryOf(read.value, intent.repositoryKey);
    const back = undoing === null ? undoOf(intent, after, read.value.version) : null;
    setOutcome({
      kind: "applied",
      sentence: appliedSentence(intent.repositoryKey, after),
      undo: back === null ? null : { intent: back, undoing: intent },
      wasUndo: undoing !== null,
    });
    onRecord(read.value);
  };

  // The record moved under an open confirmation (a poll, a run, another
  // person). Nothing is sent against a version nobody is looking at any more.
  const moved = pending !== null && pending.intent.version !== record.version;
  const movedNotice = moved && pending ? movedWhileDeciding(pending.intent.version, record.version) : null;

  const row = (repositoryKey: string, entry: RecordEntry | null) =>
    pending?.intent.repositoryKey === repositoryKey ? (
      movedNotice ? (
        <Notice
          tone="waiting"
          role="alert"
          title={movedNotice.title}
          action={
            <Button variant="secondary" size="sm" onClick={() => setPending(null)}>
              Close
            </Button>
          }
        >
          {movedNotice.body}
        </Notice>
      ) : (
        <Confirmation
          pending={pending}
          questionWaiting={questionWaiting}
          sending={sending}
          reason={reason}
          onReason={setReason}
          onConfirm={() => void send(pending)}
          onCancel={() => setPending(null)}
        />
      )
    ) : (
      <Actions
        entry={entry}
        repositoryKey={repositoryKey}
        disabled={sending}
        onPick={(action) => open(repositoryKey, action)}
      />
    );

  return (
    <div className="flex flex-col gap-3">
      {/* Above the list, not in the row it came from: a removed repository
          leaves the list, and an undo that vanishes with it is no undo. */}
      {outcome ? (
        <OutcomeNotice
          outcome={outcome}
          version={record.version}
          onUndo={(undo) => {
            setReason(null);
            setOutcome(null);
            setPending({ intent: undo.intent, undoing: undo.undoing });
          }}
          onReload={() => {
            setOutcome(null);
            onReload();
          }}
          onDismiss={() => setOutcome(null)}
        />
      ) : null}
      <ul className="m-0 flex list-none flex-col p-0">
        {record.entries.map((entry) => (
          <li
            key={entry.repositoryKey}
            className="flex flex-col gap-1 border-t border-neutral-200 py-2 first:border-t-0"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="break-all font-mono text-[12px] font-medium text-coal">{entry.repositoryKey}</span>
              <CkChip tone={entryStateTone(entry.state)}>{entryStateLabel(entry)}</CkChip>
            </div>
            <span className="font-body text-[12px] leading-[1.5] text-neutral-700">
              {actorLabel(entry.decidedBy)} on {formatMoment(entry.decidedAt)} ({entryOriginLabel(entry.origin)})
              {entry.rationale ? `: ${entry.rationale}` : ""}
            </span>
            {row(entry.repositoryKey, entry)}
          </li>
        ))}
      </ul>
      {offered.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h5 className="m-0 font-mono text-[9px] font-medium uppercase tracking-[0.06em] text-neutral-600">
            Offered in a question, not in the record
          </h5>
          <span className="font-body text-[12px] leading-[1.5] text-neutral-700">{OFFERED_LINE}</span>
          <ul className="m-0 flex list-none flex-col p-0">
            {offered.map((repositoryKey) => (
              <li key={repositoryKey} className="flex flex-col gap-1 border-t border-neutral-200 py-2 first:border-t-0">
                <span className="break-all font-mono text-[12px] font-medium text-coal">{repositoryKey}</span>
                {row(repositoryKey, null)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
