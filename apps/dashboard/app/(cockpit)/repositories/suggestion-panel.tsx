"use client";

import { useEffect, useRef, useState } from "react";

import type {
  PrePrCheckRepositoryConfig,
  RepositoryCatalogSuggestRateLimited,
  RepositoryCatalogSuggestResponse,
} from "@shared/contracts";

import { apiClient } from "@/lib/api/client";
import { usageLabel } from "@/lib/repository-catalog/format";
import {
  AUTO_RETRY_CODE,
  SUGGESTION_PENDING_NOTE,
  SUGGESTION_RETRY_NOTE,
  SUGGESTION_REVIEW_NOTICE,
  USE_THIS_LABEL,
  acceptGroupsIntoEntry,
  dropReasonLabel,
  groupDiffSummary,
  proposedGroupDiffs,
  suggestionFailureCopy,
  type SuggestedGroupDiff,
} from "@/lib/repository-catalog/suggestion";
import { emptyScriptsEntry } from "@/components/cockpit/screens/repositories/script-groups";

type State =
  | { kind: "idle" }
  | { kind: "pending"; retrying: boolean }
  | { kind: "failed"; message: string; retryable: boolean }
  | { kind: "proposed"; answer: RepositoryCatalogSuggestResponse };

function errorCodeOf(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const body = error as { statusMessage?: unknown; message?: unknown; error?: unknown };
  for (const value of [body.error, body.statusMessage, body.message]) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function CommandList({
  commands,
  muted,
}: {
  commands: readonly string[];
  muted?: boolean;
}) {
  if (commands.length === 0) {
    return <div className="font-body text-[11px] text-neutral-500">No commands.</div>;
  }
  return (
    <ol className="m-0 list-none p-0">
      {commands.map((command, index) => (
        <li
          key={`${index}:${command}`}
          className={`font-mono text-[11px] ${muted ? "text-neutral-500" : "text-neutral-800"}`}
        >
          {index + 1}. {command.trim().length === 0 ? "(blank)" : command}
        </li>
      ))}
    </ol>
  );
}

/**
 * Asking a model to read the repository, and reviewing what it says.
 *
 * Two rules the shape of this component exists to keep. Nothing here ever
 * prefills a submittable form: every proposed group is a diff with its commands
 * listed verbatim and a tick of its own, there is no "use all", and an accepted
 * group lands in the Scripts tab's DRAFT, which the admin still saves with a
 * reason. And a dropped group is shown with its reason and its commands, greyed
 * out, with no way to accept it: an admin who cannot tell "the repository has
 * no tests" from "the model proposed one and it was refused" learns to distrust
 * the whole screen.
 */
export function SuggestionPanel({
  repositoryId,
  repository,
  currentEntry,
  currentDescription,
  currentRules,
  onUseDescription,
  onUseRules,
  onAcceptGroups,
}: {
  repositoryId: number;
  /** Identity off the stored row. A repository with no scripts entry yet needs
   *  one built, and building it from a default provider would write a GitLab
   *  repository into the audited profile blob as a GitHub one. */
  repository: { provider: "github" | "gitlab"; path: string };
  /** What the Scripts tab holds right now, which is what the diff is against. */
  currentEntry: PrePrCheckRepositoryConfig | null;
  /** What the Overview and Rules tabs hold right now. "Use this" overwrites
   *  them, so they are rendered beside the proposal rather than left behind a
   *  tab switch nobody makes before clicking. */
  currentDescription: string;
  currentRules: string;
  onUseDescription: (description: string) => void;
  onUseRules: (rules: string) => void;
  onAcceptGroups: (next: PrePrCheckRepositoryConfig) => void;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(() => new Set());
  // Seconds left on a 429, counted down in the button label. The worker refuses
  // the call until the window passes, so offering the click would spend a round
  // trip to be told the same thing again.
  const [cooldown, setCooldown] = useState(0);
  // At most one automatic retry per attempt, and only for a provider that is
  // not answering: see AUTO_RETRY_CODE for why a timeout is not repeated.
  const autoRetried = useRef(false);
  // A second click while a call is in flight would spend a second suggestion on
  // the same repository and race the first answer onto the screen.
  const inFlight = useRef(false);

  async function ask(isAutoRetry = false) {
    if (inFlight.current || cooldown > 0) return;
    inFlight.current = true;
    if (!isAutoRetry) autoRetried.current = false;
    setState({ kind: "pending", retrying: isAutoRetry });
    setAccepted(new Set());
    try {
      const result = await apiClient.repositoryCatalog.suggest(repositoryId);
      if (result.ok && result.status === 429) {
        const limited = result.data as RepositoryCatalogSuggestRateLimited;
        setCooldown(
          typeof limited.retryAfterSeconds === "number" ? limited.retryAfterSeconds : 0,
        );
        setState({
          kind: "failed",
          ...suggestionFailureCopy({
            status: 429,
            code: "suggestion_rate_limited",
            retryAfterSeconds: limited.retryAfterSeconds,
          }),
        });
        return;
      }
      if (!result.ok) {
        const code = errorCodeOf(result.error);
        const copy = suggestionFailureCopy({ status: result.status, code });
        if (code === AUTO_RETRY_CODE && !autoRetried.current) {
          autoRetried.current = true;
          inFlight.current = false;
          await ask(true);
          return;
        }
        setState({ kind: "failed", ...copy });
        return;
      }
      setState({ kind: "proposed", answer: result.data as RepositoryCatalogSuggestResponse });
    } catch {
      setState({
        kind: "failed",
        message: "Could not reach the server. Check your connection and try again.",
        retryable: true,
      });
    } finally {
      inFlight.current = false;
    }
  }

  // One interval while the window is open, and nothing running when it is not.
  const cooling = cooldown > 0;
  useEffect(() => {
    if (!cooling || typeof window === "undefined") return;
    const timer = window.setInterval(() => {
      setCooldown((left) => (left <= 1 ? 0 : left - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooling]);

  const diffs: SuggestedGroupDiff[] =
    state.kind === "proposed"
      ? proposedGroupDiffs(currentEntry, state.answer.proposal.scriptGroups)
      : [];

  function toggle(name: string) {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <section className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 font-display text-[15px] font-medium text-coal">
          Suggest from repository
        </h3>
        <button
          onClick={() => void ask()}
          disabled={state.kind === "pending" || cooling}
          className="appearance-none rounded-[3px] border border-neutral-300 bg-white px-3 py-[6px] font-body text-[12px] text-neutral-800 cursor-pointer hover:bg-app-bg disabled:opacity-40 disabled:cursor-default"
        >
          {cooling
            ? `Rate limited, ${cooldown}s`
            : state.kind === "pending"
              ? "Reading the repository…"
              : state.kind === "idle"
                ? "Suggest from repository"
                : "Ask again"}
        </button>
      </div>

      {state.kind === "idle" && (
        <p className="m-0 mt-2 font-body text-[12px] text-neutral-600">
          A model reads this repository&apos;s own files and proposes a
          description, rules and script groups. Nothing is saved by it: every
          proposal is shown beside the current value for you to accept one at a
          time.
        </p>
      )}

      {state.kind === "pending" && (
        <p role="status" className="m-0 mt-2 font-body text-[12px] text-neutral-600">
          {state.retrying
            ? `Asking again. ${SUGGESTION_RETRY_NOTE}`
            : `Reading the repository and asking the model. ${SUGGESTION_PENDING_NOTE}`}
        </p>
      )}

      {state.kind === "failed" && (
        <div className="mt-2">
          <div
            role="status"
            className="rounded-[3px] border border-red-300 bg-red-50 px-2 py-[6px] font-body text-[12px] text-red-700"
          >
            {state.message}
          </div>
          {state.retryable && !cooling && (
            <button
              onClick={() => void ask()}
              className="mt-2 appearance-none rounded-[3px] border border-neutral-300 bg-white px-3 py-[6px] font-body text-[12px] text-neutral-800 cursor-pointer hover:bg-app-bg"
            >
              Try again
            </button>
          )}
        </div>
      )}

      {state.kind === "proposed" && (
        <div className="mt-2">
          <div className="rounded-[3px] border border-orange-300 bg-orange-100 px-2 py-[6px] font-body text-[11px] text-[#A23E18]">
            {SUGGESTION_REVIEW_NOTICE}
          </div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
            {state.answer.model} · {usageLabel(state.answer.usage)}
          </div>

          <SuggestedField
            label="Description"
            current={currentDescription}
            proposed={state.answer.proposal.description}
            onUse={() => onUseDescription(state.answer.proposal.description)}
          />
          <SuggestedField
            label="Rules"
            current={currentRules}
            proposed={state.answer.proposal.rules}
            onUse={() => onUseRules(state.answer.proposal.rules)}
          />

          <div className="mt-3 font-body text-[12px] font-semibold text-neutral-800">
            Script groups
          </div>
          {diffs.length === 0 && (
            <p className="m-0 mt-1 font-body text-[12px] text-neutral-600">
              The model proposed no script groups, which is a legitimate answer
              for a repository that declares none.
            </p>
          )}
          {diffs.map((diff) => (
            <div
              key={diff.name}
              className="mt-2 rounded-[3px] border border-neutral-200 px-2 py-[6px]"
            >
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={accepted.has(diff.name)}
                  onChange={() => toggle(diff.name)}
                />
                <span className="font-mono text-[12px] text-neutral-900">{diff.name}</span>
                <span className="font-body text-[11px] text-neutral-500">
                  {groupDiffSummary(diff)}
                </span>
              </label>
              <div className="mt-1 grid grid-cols-1 gap-2 lg:grid-cols-2">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
                    Now
                  </div>
                  <CommandList commands={diff.currentCommands} muted />
                </div>
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
                    Proposed
                  </div>
                  <CommandList commands={diff.proposedCommands} />
                </div>
              </div>
            </div>
          ))}

          {state.answer.droppedGroups.length > 0 && (
            <div className="mt-3">
              <div className="font-body text-[12px] font-semibold text-neutral-800">
                Refused, and not offered
              </div>
              {state.answer.droppedGroups.map((group) => (
                <div
                  key={group.name}
                  className="mt-1 rounded-[3px] border border-dashed border-neutral-300 px-2 py-[6px] opacity-70"
                >
                  <div className="font-mono text-[12px] text-neutral-600">{group.name}</div>
                  <div className="font-body text-[11px] text-neutral-600">
                    {dropReasonLabel(group)}
                  </div>
                  <CommandList commands={group.commands} muted />
                </div>
              ))}
            </div>
          )}

          {diffs.length > 0 && (
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={() => {
                  const base: PrePrCheckRepositoryConfig =
                    currentEntry ?? emptyScriptsEntry(repository);
                  onAcceptGroups(acceptGroupsIntoEntry(base, diffs, accepted));
                  setAccepted(new Set());
                }}
                disabled={accepted.size === 0}
                className="appearance-none rounded-[3px] border border-neutral-300 bg-white px-3 py-[6px] font-body text-[12px] text-neutral-800 cursor-pointer hover:bg-app-bg disabled:opacity-40 disabled:cursor-default"
              >
                Move {accepted.size} into the Scripts draft
              </button>
              <span className="font-body text-[11px] text-neutral-500">
                Accepted groups land in the Scripts tab as an unsaved draft. You
                still save them with a reason.
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One markdown field, both sides of it.
 *
 * `Use this` replaces the stored text outright, so the stored text is on screen
 * next to the proposal: the same Now/Proposed pair the script groups get, for
 * the same reason. A description written by hand last quarter and a description
 * a model just invented look identical once one has overwritten the other.
 */
function SuggestedField({
  label,
  current,
  proposed,
  onUse,
}: {
  label: string;
  current: string;
  proposed: string;
  onUse: () => void;
}) {
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-body text-[12px] font-semibold text-neutral-800">{label}</div>
        {proposed.trim().length > 0 && (
          <button
            onClick={onUse}
            className="appearance-none border-none bg-transparent px-0 font-body text-[12px] text-mariner cursor-pointer"
          >
            {USE_THIS_LABEL}
          </button>
        )}
      </div>
      <div className="mt-1 grid grid-cols-1 gap-2 lg:grid-cols-2">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
            Now
          </div>
          <pre className="m-0 whitespace-pre-wrap font-body text-[12px] text-neutral-500">
            {current.trim().length === 0 ? "(nothing recorded)" : current}
          </pre>
        </div>
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
            Proposed
          </div>
          <pre className="m-0 whitespace-pre-wrap font-body text-[12px] text-neutral-800">
            {proposed.trim().length === 0 ? "(the model proposed nothing here)" : proposed}
          </pre>
        </div>
      </div>
    </div>
  );
}
