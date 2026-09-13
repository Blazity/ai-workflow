"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { UserIcon } from "@phosphor-icons/react/dist/csr/User";
import type {
  ManualDispatchInput,
  ManualDispatchPreflightResponse,
  ManualDispatchResponse,
} from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import { apiClient } from "@/lib/api/client";
import { blockPresentation } from "./flow-editor/block-palette";
import type { WorkflowEditorOptions } from "@shared/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";

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
      const response = await apiClient.triggers.manualDispatchPreflight(
        definitionId,
        trigger.id,
        dispatchInput(),
      );
      if (!response.ok) throw new Error(response.errorMessage);
      setPreflight(response.data);
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
      const response = await apiClient.triggers.manualDispatch(
        definitionId,
        trigger.id,
        {
          requestId: globalThis.crypto.randomUUID(),
          expectedDeployedVersion: preflight.deployedVersion,
          input: preflight.input,
        },
      );
      if (!response.ok) throw new Error(response.errorMessage);
      setResult(response.data);
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
    <Modal
      open
      onClose={onClose}
      title={`Run from ${triggerLabel}`}
      description={`${workflowName} · deployed v${deployedVersion}`}
      size="sm"
      showCloseButton
      closeLabel="Close manual dispatch"
      initialFocusRef={inputRef}
      footer={
        <div className="flex items-center justify-end gap-3">
          <Button type="button" onClick={onClose} variant="ghost">
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && preflight ? (
            <Button
              type="button"
              onClick={() => void startDispatch()}
              disabled={!preflight.runnable || busy !== null}
            >
              {busy === "dispatch" ? "Starting…" : primaryLabel}
            </Button>
          ) : null}
        </div>
      }
    >
      <div>
          <div className="mt-4 border-l-2 border-mariner bg-app-bg px-3 py-2 font-body text-[12px] leading-relaxed text-neutral-700">
            This runs deployed v{deployedVersion}.{" "}
            {dirty ? "Unsaved draft changes" : "Draft changes"} are excluded.
          </div>

          <form onSubmit={runPreflight} className="mt-6">
            <div className="flex items-end gap-2">
              <Field className="min-w-0 flex-1" label={isTicket ? "Ticket key" : "Pull or merge request URL"}>
                <Input
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
                  monospace
                />
              </Field>
              <Button
                type="submit"
                disabled={!rawInput.trim() || busy !== null}
                variant="secondary"
              >
                {busy === "preflight" ? "Checking…" : "Check"}
              </Button>
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
              className="mt-5 rounded-[3px] border border-fail bg-fail-bg px-3 py-2 font-body text-[12px] text-fail-fg"
            >
              {preflight.blocker.message}
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="mt-5 rounded-[3px] border border-fail bg-fail-bg px-3 py-2 font-body text-[12px] text-fail-fg"
            >
              {error}
            </div>
          )}

          {result && (
            <div
              role="status"
              className="mt-5 rounded-[3px] border border-success bg-success-bg px-4 py-3 font-body text-[13px] text-success-fg"
            >
              {result.status === "started" ? (
                <div className="flex items-center justify-between gap-3">
                  <span>
                    Workflow started. Run ID{" "}
                    <span className="font-mono text-[11px]">{result.runId}</span>
                  </span>
                  <Link
                    href={`/trace/${encodeURIComponent(result.runId)}`}
                    className="inline-flex shrink-0 items-center gap-1 font-semibold text-success-fg underline decoration-success underline-offset-2"
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
    </Modal>
  );
}
