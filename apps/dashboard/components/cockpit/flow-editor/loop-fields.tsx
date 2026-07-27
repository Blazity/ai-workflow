"use client";

import { useState } from "react";
import type {
  JsonValue,
  WorkflowDataCatalogEntry,
  WorkflowLoopCarryV2,
  WorkflowValueCompatibility,
} from "@shared/contracts";
import {
  WorkflowDataPicker,
  WorkflowValueChip,
} from "./workflow-data-picker";

function parseCarry(
  configuration: Readonly<Record<string, JsonValue>>,
): WorkflowLoopCarryV2[] {
  return Array.isArray(configuration.carry)
    ? configuration.carry as unknown as WorkflowLoopCarryV2[]
    : [];
}

function carryCompatibility(
  entry: WorkflowDataCatalogEntry,
): WorkflowValueCompatibility {
  if (entry.availability.state === "unavailable") {
    return {
      compatible: false,
      reason: {
        code: "graph_unavailable",
        message: entry.availability.reason,
      },
    };
  }
  if (
    entry.presence === "optional" ||
    entry.presence === "optional_nullable"
  ) {
    return {
      compatible: false,
      reason: {
        code: "presence_optional",
        message: "This value is not present whenever the Loop is reached.",
      },
    };
  }
  return { compatible: true };
}

function carryName(
  entry: WorkflowDataCatalogEntry,
  existing: readonly WorkflowLoopCarryV2[],
): string {
  const base =
    entry.reference.match(/^steps\.([^.]+)\.output$/)?.[1] ??
    entry.reference.split(".").at(-1) ??
    "value";
  const safe = base
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^[^A-Za-z_]+/, "") || "value";
  const names = new Set(existing.map((carry) => carry.name));
  if (!names.has(safe)) return safe;
  let suffix = 2;
  while (names.has(`${safe}_${suffix}`)) suffix += 1;
  return `${safe}_${suffix}`;
}

export function LoopFields({
  configuration,
  availableValues,
  valuesRefreshing,
  canEdit,
  onChange,
}: {
  configuration: Readonly<Record<string, JsonValue>>;
  availableValues: readonly WorkflowDataCatalogEntry[];
  valuesRefreshing: boolean;
  canEdit: boolean;
  onChange: (configuration: Record<string, JsonValue>) => void;
}) {
  const [pickerIndex, setPickerIndex] = useState<number | "new" | null>(null);
  const carry = parseCarry(configuration);
  const update = (nextCarry: WorkflowLoopCarryV2[]) => {
    onChange({
      ...configuration,
      carry: nextCarry as unknown as JsonValue,
    });
  };
  const selectedReference =
    typeof pickerIndex === "number" &&
    carry[pickerIndex]?.binding.kind === "reference"
      ? carry[pickerIndex].binding.reference
      : undefined;

  return (
    <section className="border-b border-neutral-200 px-[14px] py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="m-0 font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
            Values for the next retry
          </h3>
          <p className="m-0 mt-1 font-body text-[11px] leading-[1.45] text-neutral-500">
            Freeze the current results that Fix should receive in the next Loop pass.
          </p>
        </div>
        <button
          type="button"
          disabled={!canEdit || valuesRefreshing}
          onClick={() => setPickerIndex("new")}
          className="shrink-0 border-none bg-transparent font-mono text-[9px] uppercase tracking-[0.05em] text-mariner disabled:opacity-40"
        >
          + Add value
        </button>
      </div>
      <div className="mt-3 space-y-3">
        {carry.map((item, index) => {
          const reference =
            item.binding.kind === "reference"
              ? item.binding.reference
              : undefined;
          const selected =
            reference === undefined
              ? null
              : availableValues.find(
                  (entry) => entry.reference === reference,
                ) ?? null;
          const compatibility = selected
            ? carryCompatibility(selected)
            : null;
          return (
            <div
              key={`${item.name}:${index}`}
              className="space-y-2 rounded-[3px] border border-neutral-200 bg-off-white p-2.5"
            >
              <div className="flex items-center gap-2">
                <input
                  aria-label={`Carried value ${index + 1} name`}
                  value={item.name}
                  disabled={!canEdit}
                  onChange={(event) => {
                    const next = [...carry];
                    next[index] = { ...item, name: event.target.value };
                    update(next);
                  }}
                  className="h-8 min-w-0 flex-1 rounded-[3px] border border-neutral-200 bg-panel px-2 font-mono text-[11px] outline-none disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={!canEdit}
                  aria-label={`Remove carried value ${item.name}`}
                  onClick={() => update(carry.filter((_, itemIndex) => itemIndex !== index))}
                  className="size-8 rounded-[3px] border border-neutral-200 bg-panel font-mono text-neutral-500 disabled:opacity-40"
                >
                  ×
                </button>
              </div>
              <WorkflowValueChip
                value={selected}
                reference={reference}
                invalidReason={
                  compatibility?.compatible === false
                    ? compatibility.reason?.message
                    : item.binding.kind !== "reference"
                      ? "Choose one workflow value for this carried result."
                      : null
                }
                disabled={!canEdit || valuesRefreshing}
                onOpen={() => setPickerIndex(index)}
              />
            </div>
          );
        })}
        {carry.length === 0 && (
          <p className="m-0 rounded-[3px] border border-dashed border-neutral-300 px-3 py-3 font-body text-[11px] text-neutral-500">
            No values are carried into retries.
          </p>
        )}
      </div>
      <WorkflowDataPicker
        open={pickerIndex !== null}
        entries={availableValues}
        selectedReference={selectedReference}
        refreshing={valuesRefreshing}
        compatibility={carryCompatibility}
        onClose={() => setPickerIndex(null)}
        onSelect={(entry) => {
          if (pickerIndex === "new") {
            update([
              ...carry,
              {
                name: carryName(entry, carry),
                schema: structuredClone(entry.schema),
                binding: {
                  kind: "reference",
                  reference: entry.reference,
                },
              },
            ]);
          } else if (typeof pickerIndex === "number") {
            const next = [...carry];
            const current = next[pickerIndex];
            if (current) {
              next[pickerIndex] = {
                ...current,
                schema: structuredClone(entry.schema),
                binding: {
                  kind: "reference",
                  reference: entry.reference,
                },
              };
              update(next);
            }
          }
          setPickerIndex(null);
        }}
      />
    </section>
  );
}
