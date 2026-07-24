"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  JsonSchema202012,
  WorkflowDataCatalogEntry,
  WorkflowDataReferenceV2,
} from "@shared/contracts";

type PickerTab = "steps" | "run";

export type WorkflowDataCompatibility = (
  entry: WorkflowDataCatalogEntry,
) => { compatible: true } | { compatible: false; reason: string };

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
  return result.compatible ? null : result.reason;
}

export function textTemplateCompatibility(
  entry: WorkflowDataCatalogEntry,
):
  | { compatible: true }
  | { compatible: false; reason: string } {
  if (
    entry.presence !== "required" ||
    (Array.isArray(entry.schema.type) &&
      entry.schema.type.includes("null"))
  ) {
    return {
      compatible: false,
      reason: "This value may be missing or null when the block runs.",
    };
  }
  const types = Array.isArray(entry.schema.type)
    ? entry.schema.type
    : [entry.schema.type];
  const stringEnum =
    Array.isArray(entry.schema.enum) &&
    entry.schema.enum.length > 0 &&
    entry.schema.enum.every((value) => typeof value === "string");
  if (!types.includes("string") && !stringEnum) {
    return {
      compatible: false,
      reason: "Only guaranteed text values can be inserted into text.",
    };
  }
  return { compatible: true };
}

export function inputCompatibility(
  inputName: string,
): WorkflowDataCompatibility {
  return (entry) =>
    entry.compatibleInputNames.includes(inputName)
      ? { compatible: true }
      : {
          compatible: false,
          reason: "This value is not compatible with this input.",
        };
}

export function WorkflowValueChip({
  value,
  reference,
  disabled,
  onOpen,
  onClear,
}: {
  value: WorkflowDataCatalogEntry | null;
  reference?: WorkflowDataReferenceV2;
  disabled?: boolean;
  onOpen: () => void;
  onClear?: () => void;
}) {
  if (!value) {
    return (
      <div className="space-y-1">
        <button
          type="button"
          disabled={disabled}
          onClick={onOpen}
          className="flex min-h-9 w-full items-center gap-2 rounded-[3px] border border-dashed border-neutral-300 bg-panel px-3 text-left font-body text-[12px] text-mariner disabled:opacity-50"
        >
          <span aria-hidden>＋</span>
          Choose workflow value
        </button>
        {reference && (
          <p className="m-0 font-body text-[10px] leading-[1.35] text-red-700">
            The saved value is unavailable in the current workflow.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="flex min-h-10 overflow-hidden rounded-[3px] border border-neutral-200 bg-panel">
      <button
        type="button"
        disabled={disabled}
        onClick={onOpen}
        aria-label={`Change ${value.label}`}
        className="flex min-w-0 flex-1 items-center gap-2 border-none bg-transparent px-2.5 py-1.5 text-left disabled:opacity-50"
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
      </button>
      {onClear && (
        <button
          type="button"
          disabled={disabled}
          onClick={onClear}
          aria-label={`Remove ${value.label}`}
          className="w-9 shrink-0 border-y-0 border-r-0 border-l border-neutral-200 bg-transparent font-mono text-[13px] text-neutral-500 disabled:opacity-50"
        >
          ×
        </button>
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
  const [unavailableOpen, setUnavailableOpen] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => searchRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
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
  const visibleEntries = useMemo(
    () =>
      entries.filter((entry) => {
        const expectedTab = entry.source.kind === "run" ? "run" : "steps";
        return (
          expectedTab === tab &&
          `${entry.label} ${entry.description} ${schemaType(entry.schema)}`
            .toLowerCase()
            .includes(normalizedQuery)
        );
      }),
    [entries, normalizedQuery, tab],
  );
  const available = visibleEntries.filter(
    (entry) => availableReason(entry, compatibility) === null,
  );
  const unavailable = visibleEntries
    .map((entry) => ({
      entry,
      reason: availableReason(entry, compatibility),
    }))
    .filter(
      (
        item,
      ): item is { entry: WorkflowDataCatalogEntry; reason: string } =>
        item.reason !== null,
    );
  const grouped = useMemo(() => {
    const groups = new Map<string, WorkflowDataCatalogEntry[]>();
    for (const entry of available) {
      const key = sourceKey(entry);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    return groups;
  }, [available]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/25 p-4"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Choose workflow value"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[min(680px,calc(100vh-32px))] w-full max-w-[560px] flex-col overflow-hidden rounded-[6px] border border-neutral-200 bg-panel shadow-[0_24px_70px_-20px_rgba(24,27,32,0.45)]"
      >
        <header className="flex items-start justify-between border-b border-neutral-200 px-5 py-4">
          <div>
            <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-neutral-500">
              Workflow data
            </span>
            <h2 className="m-0 mt-1 font-display text-xl font-medium text-coal">
              Choose a value
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close workflow value picker"
            className="size-8 border-none bg-transparent font-mono text-lg text-neutral-500"
          >
            ×
          </button>
        </header>
        <div className="p-4 pb-0">
          <label className="flex h-10 items-center gap-2 rounded-[3px] border border-neutral-200 bg-off-white px-3">
            <span aria-hidden className="text-neutral-400">
              ⌕
            </span>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search steps and fields"
              className="min-w-0 flex-1 border-none bg-transparent font-body text-[12px] outline-none"
            />
          </label>
        </div>
        <nav
          aria-label="Workflow data sources"
          className="flex border-b border-neutral-200 px-4 pt-3"
        >
          {([
            ["steps", "Previous steps"],
            ["run", "Run info"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              aria-pressed={tab === value}
              className={`border-x-0 border-t-0 bg-transparent px-3 py-2 font-body text-[12px] ${
                tab === value
                  ? "border-b-2 border-mariner text-mariner"
                  : "border-b-2 border-transparent text-neutral-600"
              }`}
            >
              {label}
            </button>
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
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  className="flex w-full items-center gap-2 border-none bg-transparent px-2 py-2.5 text-left"
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
                </button>
                {isExpanded && (
                  <div className="pb-2 pl-9">
                    {values.map((entry) => (
                      <button
                        key={entry.reference}
                        type="button"
                        data-picker-value
                        disabled={refreshing}
                        aria-current={
                          selectedReference === entry.reference
                            ? "true"
                            : undefined
                        }
                        onClick={() => onSelect(entry)}
                        className={`flex w-full items-start gap-3 rounded-[3px] border-none px-3 py-2 text-left disabled:opacity-50 ${
                          selectedReference === entry.reference
                            ? "bg-mariner-100"
                            : "bg-transparent hover:bg-off-white"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <strong className="block font-body text-[12px] font-medium text-coal">
                            {fieldName(entry)}
                          </strong>
                          <small className="block font-body text-[10px] leading-[1.4] text-neutral-500">
                            {entry.description}
                          </small>
                        </span>
                        <span className="rounded-full bg-off-white px-2 py-0.5 font-mono text-[8px] uppercase text-neutral-500">
                          {schemaType(entry.schema)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {grouped.size === 0 && unavailable.length === 0 && (
            <div className="px-3 py-8 text-center font-body text-[12px] text-neutral-500">
              No workflow values match this search.
            </div>
          )}
          {unavailable.length > 0 && (
            <div className="mt-2 border-t border-neutral-200 pt-2">
              <button
                type="button"
                aria-expanded={unavailableOpen}
                onClick={() => setUnavailableOpen((current) => !current)}
                className="flex w-full items-center gap-2 border-none bg-transparent px-2 py-2 font-body text-[11px] text-neutral-600"
              >
                <span aria-hidden>⚠</span>
                Unavailable
                <span className="rounded-full bg-off-white px-1.5 font-mono text-[9px]">
                  {unavailable.length}
                </span>
                <span className="ml-auto font-mono text-[10px]">
                  {unavailableOpen ? "▴" : "▾"}
                </span>
              </button>
              {unavailableOpen && (
                <div className="space-y-1 px-2 pb-2">
                  {unavailable.map(({ entry, reason }) => (
                    <div
                      key={entry.reference}
                      className="rounded-[3px] bg-off-white px-3 py-2"
                    >
                      <strong className="block font-body text-[11px] font-medium text-neutral-700">
                        {entry.label}
                      </strong>
                      <small className="block font-body text-[10px] leading-[1.4] text-neutral-500">
                        {reason}
                      </small>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
