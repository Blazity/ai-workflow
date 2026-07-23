"use client";

import { useEffect, useRef, useState } from "react";
import type {
  WorkflowDefinitionMigrationDiagnostic,
  WorkflowDefinitionMigrationPreview,
} from "@shared/contracts";
import {
  DIALOG_FOCUSABLE_SELECTOR,
  initialDialogFocusTarget,
  trappedDialogTabTarget,
} from "@/lib/prompt-library/prompt-editor-modal-contract";

export type WorkflowMigrationDrawerState =
  | { kind: "save_required" }
  | { kind: "loading" }
  | { kind: "preview"; preview: WorkflowDefinitionMigrationPreview }
  | { kind: "applying"; preview: WorkflowDefinitionMigrationPreview }
  | { kind: "error"; message: string; stale: boolean }
  | { kind: "success"; deployedVersion: number | null };

export function workflowMigrationVisibility(
  schemaVersion: 1 | 2,
  canEdit: boolean,
) {
  return {
    showLegacyStatus: schemaVersion === 1,
    showMigrationAction: schemaVersion === 1 && canEdit,
  };
}

export function canApplyWorkflowMigration(
  preview: WorkflowDefinitionMigrationPreview,
): boolean {
  return Boolean(
    preview.definition &&
      preview.conversionHash &&
      preview.blockers.length === 0,
  );
}

export function WorkflowMigrationDrawer({
  open,
  state,
  workflowName,
  onClose,
  onSaveAndPreview,
  onRetry,
  onApply,
  onOpenNode,
}: {
  open: boolean;
  state: WorkflowMigrationDrawerState;
  workflowName: string;
  onClose: () => void;
  onSaveAndPreview: () => void;
  onRetry: () => void;
  onApply: () => void;
  onOpenNode: (nodeId: string) => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [showAllConversions, setShowAllConversions] = useState(false);

  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
      );
      const preferred = dialog.querySelector<HTMLElement>(
        "[data-dialog-initial-focus]",
      );
      initialDialogFocusTarget(preferred, focusable, dialog).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const target = trappedDialogTabTarget(
        focusable,
        document.activeElement as HTMLElement | null,
        event.shiftKey,
      );
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      restoreFocus.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (open) setShowAllConversions(false);
  }, [open, state.kind]);

  if (!open) return null;

  const preview =
    state.kind === "preview" || state.kind === "applying"
      ? state.preview
      : null;
  const canApply = Boolean(
    preview &&
      canApplyWorkflowMigration(preview) &&
      state.kind === "preview",
  );

  return (
    <div className="absolute inset-0 z-[80] flex justify-end bg-coal/20">
      <button
        type="button"
        className="absolute inset-0 cursor-default border-none bg-transparent"
        aria-label="Close migration"
        onClick={onClose}
      />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-migration-title"
        tabIndex={-1}
        className="relative flex h-full w-full flex-col overflow-hidden border-l border-neutral-200 bg-panel shadow-[-14px_0_36px_-20px_rgba(24,27,32,0.35)] sm:max-w-[520px]"
      >
        <header className="flex shrink-0 items-start gap-4 border-b border-neutral-200 px-6 py-5">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-mariner">
              Upgrade workflow
            </p>
            <h2
              id="workflow-migration-title"
              className="mt-1 truncate font-display text-[20px] font-semibold text-coal"
            >
              Migrate {workflowName} to v2
            </h2>
            <p className="mt-1 font-body text-[12px] leading-5 text-neutral-600">
              Your deployed v1 stays live. This creates a separate v2 draft for
              review.
            </p>
          </div>
          <button
            type="button"
            data-dialog-initial-focus
            onClick={onClose}
            className="ml-auto shrink-0 appearance-none rounded-[3px] border border-neutral-200 bg-panel px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-700 hover:bg-app-bg"
          >
            Close
          </button>
        </header>

        <div
          className="grid shrink-0 grid-cols-3 border-b border-neutral-200 bg-app-bg px-6"
          aria-label="Migration steps"
        >
          {["Preview", "Review", "Create draft"].map((step, index) => {
            const active =
              state.kind === "success"
                ? index <= 2
                : state.kind === "preview" || state.kind === "applying"
                  ? index <= 1
                  : index === 0;
            return (
              <div
                key={step}
                className={`border-b-2 py-3 font-mono text-[10px] uppercase tracking-[0.06em] ${
                  active
                    ? "border-mariner text-mariner"
                    : "border-transparent text-neutral-400"
                }`}
              >
                {index + 1}. {step}
              </div>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {state.kind === "save_required" && (
            <MigrationMessage
              eyebrow="Save first"
              title="Save your latest changes before previewing"
              body="Migration always uses an exact saved version, so the preview cannot drift from what becomes the v2 draft."
              actionLabel="Save & preview"
              onAction={onSaveAndPreview}
            />
          )}

          {state.kind === "loading" && (
            <MigrationMessage
              eyebrow="Preparing preview"
              title="Checking this workflow for v2"
              body="We’re applying safe upgrades and validating the complete candidate. Nothing is being saved yet."
            />
          )}

          {state.kind === "error" && (
            <MigrationMessage
              eyebrow={state.stale ? "Preview is out of date" : "Preview failed"}
              title={
                state.stale
                  ? "The workflow or its prompts changed"
                  : "We couldn’t prepare the migration"
              }
              body={state.message}
              actionLabel="Preview again"
              onAction={onRetry}
              tone="error"
            />
          )}

          {state.kind === "success" && (
            <MigrationMessage
              eyebrow="V2 draft created"
              title="Your upgraded draft is ready"
              body={
                state.deployedVersion === null
                  ? "The v2 draft is loaded. Nothing is deployed until you use the existing Deploy action."
                  : `The v2 draft is loaded. Production still runs deployed v1 version ${state.deployedVersion} until you choose Deploy.`
              }
              actionLabel="Review v2 draft"
              onAction={onClose}
              tone="success"
            />
          )}

          {preview && (
            <div className="space-y-5">
              <div className="grid grid-cols-3 gap-2">
                <CountCard
                  count={preview.conversions.length}
                  label="Automatic changes"
                  tone="default"
                />
                <CountCard
                  count={preview.warnings.length}
                  label="Review items"
                  tone="warning"
                />
                <CountCard
                  count={preview.blockers.length}
                  label="Blockers"
                  tone={preview.blockers.length > 0 ? "error" : "success"}
                />
              </div>

              <DiagnosticSection
                title="Automatic changes"
                description="Mechanical updates that preserve how this workflow behaves."
                diagnostics={
                  showAllConversions
                    ? preview.conversions
                    : preview.conversions.slice(0, 5)
                }
              />
              {preview.conversions.length > 5 && (
                <button
                  type="button"
                  className="appearance-none border-none bg-transparent font-body text-[12px] font-semibold text-mariner hover:underline"
                  onClick={() => setShowAllConversions((value) => !value)}
                >
                  {showAllConversions
                    ? "Show representative changes"
                    : `View all ${preview.conversions.length} changes`}
                </button>
              )}

              {preview.warnings.length > 0 && (
                <DiagnosticSection
                  title="Review before creating the draft"
                  description="Creating the draft confirms that you have reviewed these items."
                  diagnostics={preview.warnings}
                  tone="warning"
                  onOpenNode={onOpenNode}
                />
              )}

              {preview.blockers.length > 0 && (
                <DiagnosticSection
                  title="Resolve before migrating"
                  description="These items would change behavior or cannot be converted safely."
                  diagnostics={preview.blockers}
                  tone="error"
                  onOpenNode={onOpenNode}
                />
              )}
            </div>
          )}
        </div>

        {(state.kind === "preview" || state.kind === "applying") && (
          <footer className="shrink-0 border-t border-neutral-200 bg-panel px-6 py-4">
            <p className="mb-3 font-body text-[11px] leading-4 text-neutral-500">
              This creates a draft only. Production stays on the deployed v1
              version until you deploy the v2 draft.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onRetry}
                disabled={state.kind === "applying"}
                className="appearance-none rounded-[3px] border border-neutral-200 bg-panel px-3 py-2 font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-700 hover:bg-app-bg disabled:opacity-40"
              >
                Preview again
              </button>
              <button
                type="button"
                onClick={onApply}
                disabled={!canApply}
                className="appearance-none rounded-[3px] border border-mariner bg-mariner px-4 py-2 font-mono text-[10px] uppercase tracking-[0.05em] text-white disabled:cursor-default disabled:opacity-40"
              >
                {state.kind === "applying"
                  ? "Creating draft…"
                  : "Create v2 draft"}
              </button>
            </div>
          </footer>
        )}
      </aside>
    </div>
  );
}

function CountCard({
  count,
  label,
  tone,
}: {
  count: number;
  label: string;
  tone: "default" | "warning" | "error" | "success";
}) {
  const toneClass = {
    default: "border-neutral-200 bg-app-bg text-coal",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    error: "border-red-200 bg-red-50 text-red-800",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  }[tone];
  return (
    <div className={`rounded-[4px] border px-3 py-3 ${toneClass}`}>
      <p className="font-display text-[22px] font-semibold">{count}</p>
      <p className="mt-0.5 font-body text-[10px] leading-4">{label}</p>
    </div>
  );
}

function DiagnosticSection({
  title,
  description,
  diagnostics,
  tone = "default",
  onOpenNode,
}: {
  title: string;
  description: string;
  diagnostics: WorkflowDefinitionMigrationDiagnostic[];
  tone?: "default" | "warning" | "error";
  onOpenNode?: (nodeId: string) => void;
}) {
  const shellClass =
    tone === "error"
      ? "border-red-200 bg-red-50"
      : tone === "warning"
        ? "border-amber-200 bg-amber-50"
        : "border-neutral-200 bg-panel";
  return (
    <section className={`rounded-[4px] border ${shellClass}`}>
      <div className="border-b border-inherit px-4 py-3">
        <h3 className="font-body text-[13px] font-semibold text-coal">{title}</h3>
        <p className="mt-0.5 font-body text-[11px] leading-4 text-neutral-600">
          {description}
        </p>
      </div>
      {diagnostics.length === 0 ? (
        <p className="px-4 py-4 font-body text-[12px] text-neutral-500">
          No items.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200">
          {diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.code}:${diagnostic.path ?? ""}:${index}`} className="px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-body text-[12px] leading-5 text-neutral-800">
                    {plainDiagnosticMessage(diagnostic)}
                  </p>
                  {diagnostic.path && (
                    <p className="mt-0.5 break-all font-mono text-[9px] text-neutral-500">
                      {diagnostic.path}
                    </p>
                  )}
                </div>
                {diagnostic.nodeId && onOpenNode && (
                  <button
                    type="button"
                    onClick={() => onOpenNode(diagnostic.nodeId!)}
                    className="shrink-0 appearance-none border-none bg-transparent font-body text-[11px] font-semibold text-mariner hover:underline"
                  >
                    Open block
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MigrationMessage({
  eyebrow,
  title,
  body,
  actionLabel,
  onAction,
  tone = "default",
}: {
  eyebrow: string;
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  tone?: "default" | "error" | "success";
}) {
  const shellClass =
    tone === "error"
      ? "border-red-200 bg-red-50"
      : tone === "success"
        ? "border-emerald-200 bg-emerald-50"
        : "border-neutral-200 bg-app-bg";
  return (
    <div className={`rounded-[4px] border px-5 py-5 ${shellClass}`}>
      <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-neutral-500">
        {eyebrow}
      </p>
      <h3 className="mt-2 font-display text-[18px] font-semibold text-coal">
        {title}
      </h3>
      <p className="mt-2 font-body text-[12px] leading-5 text-neutral-600">
        {body}
      </p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-4 appearance-none rounded-[3px] border border-mariner bg-mariner px-4 py-2 font-mono text-[10px] uppercase tracking-[0.05em] text-white"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function plainDiagnosticMessage(
  diagnostic: WorkflowDefinitionMigrationDiagnostic,
): string {
  if (diagnostic.code === "migration.prompt.default_materialized") {
    return diagnostic.message.replace(/^Materialized/, "Added");
  }
  if (diagnostic.code === "migration.edge.id_assigned") {
    return "Added stable connection IDs so this workflow remains editable.";
  }
  if (diagnostic.code === "migration.branch.condition_parsed") {
    return "Converted the branch rule into the visual v2 condition format.";
  }
  if (diagnostic.code === "migration.binding.canonicalized") {
    return "Converted an existing input mapping into the v2 workflow value format.";
  }
  return diagnostic.message;
}
