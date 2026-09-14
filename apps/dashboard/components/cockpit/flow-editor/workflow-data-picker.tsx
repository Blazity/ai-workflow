"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  JsonSchema202012,
  WorkflowDataCatalogEntry,
  WorkflowDataReferenceV2,
  WorkflowValueCompatibility,
} from "@shared/contracts";
import { evaluateWorkflowValueCompatibility } from "@shared/contracts";
import { Button, IconButton, Input, Modal } from "@/components/ui";

type PickerTab = "steps" | "run";

export type WorkflowDataCompatibility = (
  entry: WorkflowDataCatalogEntry,
) => WorkflowValueCompatibility;

export function compatibilityInvalidReason(
  compatibility: WorkflowValueCompatibility | null | undefined,
): string | null {
  return !compatibility || compatibility.compatible
    ? null
    : compatibility.reason.message;
}

function schemaType(schema: JsonSchema202012): string {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return "enum";
  const values = Array.isArray(schema.type)
    ? schema.type.filter((type) => type !== "null")
    : [schema.type];
  const type = values[0];
  if (type === "string") return "text";
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array") return "list";
  if (type === "object") return "object";
  return "value";
}

function sourceName(entry: WorkflowDataCatalogEntry): string {
  const separator = entry.label.indexOf(" · ");
  return separator === -1 ? entry.label : entry.label.slice(0, separator);
}

function fieldName(entry: WorkflowDataCatalogEntry): string {
  const separator = entry.label.indexOf(" · ");
  return separator === -1 ? entry.label : entry.label.slice(separator + 3);
}

function sourceKey(entry: WorkflowDataCatalogEntry): string {
  if (entry.source.kind === "run") return "run";
  if (entry.source.kind === "trigger") {
    return `trigger:${entry.source.nodeId ?? "entry"}`;
  }
  return `step:${entry.source.nodeId ?? sourceName(entry)}`;
}

function sourceGlyph(entry: WorkflowDataCatalogEntry): string {
  if (entry.source.kind === "trigger") return "▶";
  if (entry.source.kind === "run") return "◎";
  return "↳";
}

function availableReason(
  entry: WorkflowDataCatalogEntry,
  compatibility: WorkflowDataCompatibility,
): string | null {
  if (entry.availability.state === "unavailable") {
    return entry.availability.reason;
  }
  const result = compatibility(entry);
  return compatibilityInvalidReason(result);
}

export function textTemplateCompatibility(
  entry: WorkflowDataCatalogEntry,
): WorkflowValueCompatibility {
  return evaluateWorkflowValueCompatibility(entry, { kind: "mixed_text" });
}

export function inputCompatibility(
  inputName: string,
): WorkflowDataCompatibility {
  return (entry) =>
    evaluateWorkflowValueCompatibility(entry, {
      kind: "typed_input",
      inputName,
    });
}

export function inputListItemCompatibility(
  inputName: string,
): WorkflowDataCompatibility {
  return (entry) =>
    evaluateWorkflowValueCompatibility(entry, {
      kind: "typed_list_item",
      inputName,
    });
}

export function WorkflowValueChip({
  value,
  reference,
  invalidReason,
  disabled,
  onOpen,
  onClear,
}: {
  value: WorkflowDataCatalogEntry | null;
  reference?: WorkflowDataReferenceV2;
  invalidReason?: string | null;
  disabled?: boolean;
  onOpen: () => void;
  onClear?: () => void;
}) {
  if (!value) {
    return (
      <div className="space-y-1">
        <Button
          type="button"
          variant="secondary"
          size="md"
          disabled={disabled}
          onClick={onOpen}
          className="h-auto w-full justify-start text-left"
        >
          <span aria-hidden>＋</span>
          Choose workflow value
        </Button>
        {reference && (
          <p className="m-0 font-body text-[10px] leading-[1.35] text-red-700">
            The saved value is unavailable in the current workflow.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex min-h-10 overflow-hidden rounded-[3px] border border-neutral-200 bg-panel">
        <Button
          type="button"
          variant="ghost"
          size="md"
          disabled={disabled}
          onClick={onOpen}
          aria-label={`Change ${value.label}`}
          className="h-auto min-w-0 flex-1 justify-start px-2.5 py-1.5 text-left [&>span]:w-full"
        >
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-[3px] bg-mariner-100 font-mono text-[12px] text-mariner">
            {sourceGlyph(value)}
          </span>
          <span className="min-w-0">
            <small className="block truncate font-mono text-[8px] uppercase tracking-[0.04em] text-neutral-500">
              {sourceName(value)}
            </small>
            <strong className="block truncate font-body text-[12px] font-medium text-coal">
              {fieldName(value)}
            </strong>
          </span>
          <span className="ml-auto font-mono text-[10px] text-neutral-400" aria-hidden>
            ▾
          </span>
        </Button>
        {onClear && (
          <IconButton
            type="button"
            size="md"
            disabled={disabled}
            onClick={onClear}
            aria-label={`Remove ${value.label}`}
            className="shrink-0"
          >
            ×
          </IconButton>
        )}
      </div>
      {invalidReason && (
        <p className="m-0 font-body text-[10px] leading-[1.35] text-red-700">
          {invalidReason}
        </p>
      )}
    </div>
  );
}

export function WorkflowDataPicker({
  open,
  entries,
  selectedReference,
  compatibility,
  refreshing,
  onClose,
  onSelect,
}: {
  open: boolean;
  entries: readonly WorkflowDataCatalogEntry[];
  selectedReference?: WorkflowDataReferenceV2;
  compatibility: WorkflowDataCompatibility;
  refreshing?: boolean;
  onClose: () => void;
  onSelect: (entry: WorkflowDataCatalogEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<PickerTab>("steps");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => searchRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const buttons = Array.from(
        dialogRef.current?.querySelectorAll<HTMLButtonElement>(
          "button[data-picker-value]:not([disabled])",
        ) ?? [],
      );
      if (buttons.length === 0) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "ArrowDown"
          ? (current + 1 + buttons.length) % buttons.length
          : (current - 1 + buttons.length) % buttons.length;
      event.preventDefault();
      buttons[next]?.focus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, open]);

  useEffect(() => {
    if (!open || !selectedReference) return;
    const selected = entries.find(
      (entry) => entry.reference === selectedReference,
    );
    if (!selected) return;
    setTab(selected.source.kind === "run" ? "run" : "steps");
    setExpanded((current) => new Set(current).add(sourceKey(selected)));
  }, [entries, open, selectedReference]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleEntries = useMemo(() => {
    const seen = new Set<string>();
    return entries.filter((entry) => {
        if (seen.has(entry.reference)) return false;
        seen.add(entry.reference);
        const expectedTab = entry.source.kind === "run" ? "run" : "steps";
        return (
          expectedTab === tab &&
          `${entry.label} ${entry.description} ${schemaType(entry.schema)}`
            .toLowerCase()
            .includes(normalizedQuery)
        );
      });
  }, [entries, normalizedQuery, tab]);
  const grouped = useMemo(() => {
    const groups = new Map<string, WorkflowDataCatalogEntry[]>();
    for (const entry of visibleEntries) {
      const key = sourceKey(entry);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    return groups;
  }, [visibleEntries]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose a value"
      description="Workflow data"
      size="md"
      initialFocusRef={searchRef}
      className="relative"
    >
        <div ref={dialogRef}>
          <IconButton
            type="button"
            onClick={onClose}
            aria-label="Close workflow value picker"
            size="sm"
            className="absolute right-4 top-3 z-10"
          >
            ×
          </IconButton>
          <label className="flex items-center gap-2">
            <span aria-hidden className="text-neutral-400">
              ⌕
            </span>
            <Input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search steps and fields"
              aria-label="Search steps and fields"
              className="min-w-0 flex-1"
            />
          </label>
        <nav
          aria-label="Workflow data sources"
          className="mt-3 flex border-b border-neutral-200"
        >
          {([
            ["steps", "Previous steps"],
            ["run", "Run info"],
          ] as const).map(([value, label]) => (
            <Button
              key={value}
              type="button"
              variant={tab === value ? "selected" : "ghost"}
              size="sm"
              onClick={() => setTab(value)}
              aria-pressed={tab === value}
            >
              {label}
            </Button>
          ))}
        </nav>
        {refreshing && (
          <div role="status" className="bg-mariner-100 px-5 py-2 font-body text-[11px] text-mariner">
            Refreshing values…
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {[...grouped.entries()].map(([key, values]) => {
            const isExpanded =
              expanded.has(key) || normalizedQuery.length > 0;
            return (
              <div key={key} className="border-b border-neutral-100 last:border-b-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={isExpanded}
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  className="h-auto w-full justify-start px-2 py-2.5 text-left [&>span]:w-full"
                >
                  <span className="inline-flex size-7 items-center justify-center rounded-[3px] bg-mariner-100 font-mono text-[11px] text-mariner">
                    {sourceGlyph(values[0]!)}
                  </span>
                  <span className="font-body text-[12px] font-medium text-coal">
                    {sourceName(values[0]!)}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-neutral-400">
                    {isExpanded ? "▴" : "▾"}
                  </span>
                </Button>
                {isExpanded && (
                  <div className="pb-2 pl-9">
                    {values.map((entry) => {
                      const reason = availableReason(entry, compatibility);
                      return (
                        <Button
                          key={entry.reference}
                          type="button"
                          variant={selectedReference === entry.reference ? "selected" : "ghost"}
                          size="sm"
                          data-picker-value
                          disabled={refreshing}
                          aria-disabled={reason !== null ? "true" : undefined}
                          aria-current={
                            selectedReference === entry.reference
                              ? "true"
                              : undefined
                          }
                          onClick={() => {
                            if (reason === null) onSelect(entry);
                          }}
                          className="h-auto w-full items-start justify-start px-3 py-2 text-left [&>span]:w-full [&>span]:items-start"
                        >
                          <span className="min-w-0 flex-1">
                            <strong className="block font-body text-[12px] font-medium text-coal">
                              {fieldName(entry)}
                            </strong>
                            <small className="block font-body text-[10px] leading-[1.4] text-neutral-500">
                              {reason ?? entry.description}
                            </small>
                          </span>
                          <span className="rounded-full bg-off-white px-2 py-0.5 font-mono text-[8px] uppercase text-neutral-500">
                            {schemaType(entry.schema)}
                          </span>
                        </Button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {grouped.size === 0 && (
            <div className="px-3 py-8 text-center font-body text-[12px] text-neutral-500">
              No workflow values match this search.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
