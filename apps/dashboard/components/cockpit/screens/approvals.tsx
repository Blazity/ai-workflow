"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { CkCard, CkChip, type ChipTone } from "@/components/ui";
import { readErrorMessage } from "@/lib/api/error-message";
import { Listbox } from "@/components/cockpit/listbox";
import type {
  ApprovalDecisionResponse,
  ApprovalRequest,
  ApprovalStatus,
} from "@shared/contracts";

type DecisionAction = "approve" | "reject";
type PendingConfirm = { id: string; action: DecisionAction } | null;

const STATUS_TONE: Record<ApprovalStatus, ChipTone> = {
  pending: "warn",
  approved: "success",
  rejected: "failed",
  superseded: "neutral",
};

const STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
};

export function ApprovalsScreen({
  approvals,
  canEdit,
}: {
  approvals: ApprovalRequest[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const [runIdById, setRunIdById] = useState<Record<string, string>>({});

  const filtered = filter === "pending" ? approvals.filter((a) => a.status === "pending") : approvals;

  async function decide(approval: ApprovalRequest, action: DecisionAction) {
    setBusyId(approval.id);
    setErrorById((current) => {
      const next = { ...current };
      delete next[approval.id];
      return next;
    });
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(approval.id)}/${action}`, {
        method: "POST",
      });
      if (!res.ok) {
        const message = await readErrorMessage(res);
        setErrorById((current) => ({ ...current, [approval.id]: message }));
        if (res.status === 410) router.refresh();
        return;
      }
      const decision = (await res.json()) as ApprovalDecisionResponse;
      if (action === "approve" && decision.runId) {
        setRunIdById((current) => ({ ...current, [approval.id]: decision.runId as string }));
      }
      setConfirm(null);
      router.refresh();
    } catch (err) {
      setErrorById((current) => ({
        ...current,
        [approval.id]: err instanceof Error ? err.message : "Unable to submit decision",
      }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4 px-6 pt-5 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
            Human approvals
          </div>
          <h2 className="m-0 font-display text-2xl font-medium leading-[1.2] text-neutral-900">
            {filtered.length} {filtered.length === 1 ? "approval" : "approvals"}
          </h2>
        </div>
        <div className="w-[180px]">
          <Listbox
            options={[
              { value: "pending", label: "Pending" },
              { value: "all", label: "All" },
            ]}
            value={filter}
            ariaLabel="Approval status filter"
            onChange={(v) => setFilter(v as "pending" | "all")}
          />
        </div>
      </div>

      <CkCard pad={0}>
        {filtered.length === 0 ? (
          <div className="px-4 py-10 text-center font-body text-[13px] text-neutral-500">
            {filter === "pending" ? "No pending approvals." : "No approvals yet."}
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((approval, index) => {
              const expanded = expandedId === approval.id;
              return (
                <div
                  key={approval.id}
                  className={index < filtered.length - 1 ? "border-b border-neutral-200" : ""}
                >
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : approval.id)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-mariner focus-visible:outline-offset-[-2px]"
                  >
                    <span className="font-mono text-[12px] font-semibold text-neutral-900">
                      {approval.ticketKey}
                    </span>
                    <CkChip tone={STATUS_TONE[approval.status]}>{STATUS_LABEL[approval.status]}</CkChip>
                    <span className="ml-auto font-mono text-[11px] text-neutral-500">
                      {formatDateTime(approval.requestedAt)}
                    </span>
                    <span className="font-mono text-[11px] text-neutral-700">{approval.requestedBy}</span>
                    <span
                      aria-hidden="true"
                      className={`font-mono text-[11px] text-neutral-400 transition-transform ${expanded ? "rotate-90" : ""}`}
                    >
                      ›
                    </span>
                  </button>

                  {expanded ? (
                    <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
                      <Field label="Plan">
                        <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-xs border border-neutral-200 bg-off-white p-3 font-mono text-[12px] leading-[1.5] text-coal">
                          {approval.plan.markdown}
                        </pre>
                      </Field>

                      {approval.assumptions && approval.assumptions.length > 0 ? (
                        <Field label="Assumptions">
                          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 font-body text-[13px] text-neutral-800">
                            {approval.assumptions.map((assumption, i) => (
                              <li key={i}>{assumption}</li>
                            ))}
                          </ul>
                        </Field>
                      ) : null}

                      {approval.decidedAt ? (
                        <div className="font-mono text-[11px] text-neutral-500">
                          Decided by {approval.decidedByLabel ?? approval.decidedById ?? "unknown"} ·{" "}
                          {formatDateTime(approval.decidedAt)}
                        </div>
                      ) : null}

                      {approval.dispatchedRunId ? (
                        <div className="font-mono text-[11px] text-neutral-700">
                          Dispatched run {approval.dispatchedRunId}
                        </div>
                      ) : null}

                      {errorById[approval.id] ? <InlineError>{errorById[approval.id]}</InlineError> : null}

                      {!approval.dispatchedRunId && runIdById[approval.id] ? (
                        <div className="font-mono text-[11px] text-success-fg">
                          Dispatched run {runIdById[approval.id]}
                        </div>
                      ) : null}

                      {canEdit && approval.status === "pending" ? (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          {confirm && confirm.id === approval.id ? (
                            <>
                              <span className="font-mono text-[11px] text-neutral-700">
                                Confirm {confirm.action}?
                              </span>
                              <DarkButton
                                disabled={busyId === approval.id}
                                onClick={() => decide(approval, confirm.action)}
                                type="button"
                              >
                                Confirm
                              </DarkButton>
                              <GhostButton
                                disabled={busyId === approval.id}
                                onClick={() => setConfirm(null)}
                                type="button"
                              >
                                Cancel
                              </GhostButton>
                            </>
                          ) : (
                            <>
                              <DarkButton
                                disabled={busyId === approval.id}
                                onClick={() => setConfirm({ id: approval.id, action: "approve" })}
                                type="button"
                              >
                                Approve
                              </DarkButton>
                              <GhostButton
                                danger
                                disabled={busyId === approval.id}
                                onClick={() => setConfirm({ id: approval.id, action: "reject" })}
                                type="button"
                              >
                                Reject
                              </GhostButton>
                            </>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </CkCard>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">{label}</span>
      {children}
    </div>
  );
}

function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[3px] border border-fail-bg bg-fail-bg px-3 py-2 text-[13px] text-fail-fg">
      {children}
    </div>
  );
}

function GhostButton({
  children,
  danger = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      {...props}
      className={[
        "inline-flex items-center justify-center whitespace-nowrap rounded-[3px] border bg-white px-2.5 py-[5px] font-mono text-[10px] font-medium uppercase tracking-[0.04em] transition disabled:cursor-default disabled:opacity-40",
        danger
          ? "border-[#F3CFC7] text-fail-fg hover:bg-fail-bg"
          : "border-neutral-200 text-neutral-900 hover:bg-app-bg",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function DarkButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="inline-flex items-center justify-center whitespace-nowrap rounded-[3px] border border-neutral-900 bg-neutral-900 px-3.5 py-[5px] font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-white transition hover:bg-neutral-800 disabled:cursor-default disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
