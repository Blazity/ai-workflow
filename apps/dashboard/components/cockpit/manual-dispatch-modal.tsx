"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { UserIcon } from "@phosphor-icons/react/dist/csr/User";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type {
  ManualDispatchInput,
  ManualDispatchPreflightResponse,
  ManualDispatchResponse,
} from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import { readErrorMessage } from "@/lib/api/error-message";
import { blockPresentation } from "./flow-editor/blocks";
import type { WorkflowEditorOptions } from "@shared/contracts";

export function ManualDispatchModal({
  definitionId,
  workflowName,
  deployedVersion,
  trigger,
  options,
  actorLabel,
  dirty,
  onClose,
}: {
  definitionId: number;
  workflowName: string;
  deployedVersion: number;
  trigger: FlowNodeDef;
  options: WorkflowEditorOptions;
  actorLabel: string;
  dirty: boolean;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isTicket = trigger.type === "trigger_ticket_ai";
  const triggerLabel =
    trigger.name || blockPresentation(options, trigger.type).label;
  const [rawInput, setRawInput] = useState("");
  const [preflight, setPreflight] =
    useState<ManualDispatchPreflightResponse | null>(null);
  const [result, setResult] = useState<ManualDispatchResponse | null>(null);
  const [busy, setBusy] = useState<"preflight" | "dispatch" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const dispatchInput = (): ManualDispatchInput =>
    isTicket
      ? { kind: "ticket", ticketKey: rawInput.trim() }
      : { kind: "pull_request", url: rawInput.trim() };

  async function runPreflight(event: React.FormEvent) {
    event.preventDefault();
    if (!rawInput.trim()) return;
    setBusy("preflight");
    setError(null);
    setResult(null);
    try {
      const response = await fetch(
        `/api/workflow-definitions/${definitionId}/triggers/${encodeURIComponent(trigger.id)}/manual-dispatch/preflight`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(dispatchInput()),
        },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response));
      setPreflight((await response.json()) as ManualDispatchPreflightResponse);
    } catch (caught) {
      setPreflight(null);
      setError(
        caught instanceof Error ? caught.message : "Unable to check this dispatch",
      );
    } finally {
      setBusy(null);
    }
  }

  async function startDispatch() {
    if (!preflight?.runnable) return;
    setBusy("dispatch");
    setError(null);
    try {
      const response = await fetch(
        `/api/workflow-definitions/${definitionId}/triggers/${encodeURIComponent(trigger.id)}/manual-dispatch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: globalThis.crypto.randomUUID(),
            expectedDeployedVersion: preflight.deployedVersion,
            input: preflight.input,
          }),
        },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response));
      setResult((await response.json()) as ManualDispatchResponse);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to start this workflow",
      );
    } finally {
      setBusy(null);
    }
  }

  const movesTicket =
    isTicket && preflight?.steps.some((step) => step.title.startsWith("Move "));
  const primaryLabel = movesTicket ? "Move to AI & Run" : "Run workflow";

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-coal/30 px-4 py-6 backdrop-blur-[1px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-dispatch-title"
        className="w-full max-w-[476px] overflow-hidden rounded-[6px] border border-neutral-200 bg-panel shadow-[0_18px_60px_rgba(24,27,32,0.22)]"
      >
        <div className="px-7 pb-6 pt-7">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <h2
                id="manual-dispatch-title"
                className="font-display text-[20px] font-semibold leading-tight text-coal"
              >
                Run from {triggerLabel}
              </h2>
              <p className="mt-1 font-body text-[13px] text-neutral-600">
                {workflowName} · deployed v{deployedVersion}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close manual dispatch"
              className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-neutral-600 hover:bg-app-bg hover:text-coal"
            >
              <XIcon size={19} weight="bold" aria-hidden />
            </button>
          </div>

          <div className="mt-4 border-l-2 border-mariner bg-app-bg px-3 py-2 font-body text-[12px] leading-relaxed text-neutral-700">
            This runs deployed v{deployedVersion}.{" "}
            {dirty ? "Unsaved draft changes" : "Draft changes"} are excluded.
          </div>

          <form onSubmit={runPreflight} className="mt-6">
            <label
              htmlFor="manual-dispatch-input"
              className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-600"
            >
              {isTicket ? "Ticket key" : "Pull or merge request URL"}
            </label>
            <div className="mt-2 flex gap-2">
              <input
                ref={inputRef}
                id="manual-dispatch-input"
                value={rawInput}
                onChange={(event) => {
                  setRawInput(event.target.value);
                  setPreflight(null);
                  setResult(null);
                  setError(null);
                }}
                placeholder={
                  isTicket
                    ? "AIW-173"
                    : "https://github.com/org/repo/pull/123"
                }
                autoComplete="off"
                className="h-10 min-w-0 flex-1 rounded-[3px] border border-neutral-300 bg-panel px-3 font-mono text-[13px] text-coal outline-none focus:border-mariner focus:ring-2 focus:ring-mariner/15"
              />
              <button
                type="submit"
                disabled={!rawInput.trim() || busy !== null}
                className="h-10 cursor-pointer rounded-[3px] border border-neutral-300 bg-app-bg px-3.5 font-mono text-[10px] font-semibold uppercase tracking-[0.05em] text-coal hover:border-mariner disabled:cursor-default disabled:opacity-40"
              >
                {busy === "preflight" ? "Checking…" : "Check"}
              </button>
            </div>
          </form>

          {preflight && (
            <div className="mt-5">
              <div className="font-display text-[16px] font-semibold text-coal">
                {preflight.subject.key} · {preflight.subject.title}
              </div>
              <ol className="mt-5">
                {preflight.steps.map((step, index) => (
                  <li
                    key={`${index}:${step.title}`}
                    className="relative flex gap-4 pb-5 last:pb-0"
                  >
                    {index < preflight.steps.length - 1 && (
                      <span
                        className="absolute left-[13px] top-7 h-[calc(100%-20px)] w-px bg-mariner"
                        aria-hidden
                      />
                    )}
                    <span className="relative z-[1] inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-mariner bg-panel font-mono text-[11px] font-semibold text-mariner">
                      {index + 1}
                    </span>
                    <span className="min-w-0 pt-0.5">
                      <span className="block font-body text-[14px] font-semibold text-coal">
                        {step.title}
                      </span>
                      <span className="mt-0.5 block font-body text-[12px] text-neutral-600">
                        {step.description}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {preflight?.blocker && (
            <div
              role="alert"
              className="mt-5 rounded-[3px] border border-red-300 bg-red-50 px-3 py-2 font-body text-[12px] text-red-700"
            >
              {preflight.blocker.message}
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="mt-5 rounded-[3px] border border-red-300 bg-red-50 px-3 py-2 font-body text-[12px] text-red-700"
            >
              {error}
            </div>
          )}

          {result && (
            <div
              role="status"
              className="mt-5 rounded-[3px] border border-green-300 bg-green-50 px-4 py-3 font-body text-[13px] text-green-800"
            >
              {result.status === "started" ? (
                <div className="flex items-center justify-between gap-3">
                  <span>
                    Workflow started. Run ID{" "}
                    <span className="font-mono text-[11px]">{result.runId}</span>
                  </span>
                  <Link
                    href={`/trace/${encodeURIComponent(result.runId)}`}
                    className="inline-flex shrink-0 items-center gap-1 font-semibold text-green-900 underline decoration-green-500 underline-offset-2"
                  >
                    Open run
                    <ArrowSquareOutIcon size={15} aria-hidden />
                  </Link>
                </div>
              ) : (
                <span>
                  This dispatch was accepted and is retrying safely. Request ID{" "}
                  <span className="font-mono text-[11px]">{result.requestId}</span>
                </span>
              )}
            </div>
          )}

          <div className="mt-6 flex items-center justify-between gap-4 border-t border-neutral-200 pt-4">
            <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 text-neutral-600">
              <span className="inline-flex items-center gap-2 font-body text-[12px]">
                <UserIcon size={17} aria-hidden />
                Requested by {actorLabel}
              </span>
              <span className="inline-flex items-center gap-2 font-body text-[12px]">
                <ShieldCheckIcon size={17} aria-hidden />
                One active run per {isTicket ? "ticket" : "pull request"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-neutral-200 bg-app-bg px-7 py-4">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer border-none bg-transparent px-2 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-neutral-700"
          >
            {result ? "Close" : "Cancel"}
          </button>
          {!result && preflight && (
            <button
              type="button"
              onClick={() => void startDispatch()}
              disabled={!preflight.runnable || busy !== null}
              className="cursor-pointer rounded-[3px] border border-mariner bg-mariner px-4 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-white shadow-[0_2px_4px_rgba(60,67,231,0.2)] hover:bg-[#3037d8] disabled:cursor-default disabled:opacity-40"
            >
              {busy === "dispatch" ? "Starting…" : primaryLabel}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
