"use client";

import { useState } from "react";
import type {
  JsonValue,
  WorkflowBranchConditionV2,
  WorkflowBranchConfigurationV2,
  WorkflowBranchOperatorV2,
  WorkflowDataCatalogEntry,
  WorkflowDataReferenceV2,
} from "@shared/contracts";
import {
  WorkflowDataPicker,
  WorkflowValueChip,
} from "./workflow-data-picker";

const inputClass =
  "h-9 min-w-0 rounded-[3px] border border-neutral-200 bg-off-white px-2.5 font-body text-[12px] text-coal outline-none disabled:opacity-50";
const buttonClass =
  "h-8 rounded-[3px] border border-mariner bg-panel px-3 font-mono text-[9px] uppercase tracking-[0.05em] text-mariner disabled:opacity-40";

function schemaTypes(entry: WorkflowDataCatalogEntry): string[] {
  const raw = entry.schema.type;
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string");
  }
  return typeof raw === "string" ? [raw] : [];
}

function operators(entry: WorkflowDataCatalogEntry): WorkflowBranchOperatorV2[] {
  const types = schemaTypes(entry);
  const result: WorkflowBranchOperatorV2[] = ["equals", "not_equals"];
  if (types.includes("string")) result.push("contains", "not_contains");
  if (types.includes("number") || types.includes("integer")) {
    result.push(
      "greater_than",
      "greater_than_or_equal",
      "less_than",
      "less_than_or_equal",
    );
  }
  if (
    entry.presence !== "required" ||
    types.includes("null")
  ) {
    result.push("has_value", "has_no_value");
  }
  return result;
}

function defaultValue(entry: WorkflowDataCatalogEntry): string | number | boolean {
  const first = (Array.isArray(entry.schema.enum) ? entry.schema.enum : []).find(
    (value): value is string | number | boolean =>
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean",
  );
  if (first !== undefined) return first;
  const types = schemaTypes(entry);
  if (types.includes("boolean")) return true;
  if (types.includes("number") || types.includes("integer")) return 0;
  return "";
}

function parseConfiguration(
  value: Readonly<Record<string, JsonValue>>,
): WorkflowBranchConfigurationV2 | null {
  if (
    (value.combinator !== "all" && value.combinator !== "any") ||
    !Array.isArray(value.conditions)
  ) {
    return null;
  }
  return value as unknown as WorkflowBranchConfigurationV2;
}

function ReferencePicker({
  condition,
  entries,
  refreshing,
  disabled,
  onChange,
}: {
  condition: WorkflowBranchConditionV2;
  entries: readonly WorkflowDataCatalogEntry[];
  refreshing: boolean;
  disabled: boolean;
  onChange: (entry: WorkflowDataCatalogEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected =
    entries.find((entry) => entry.reference === condition.reference) ?? null;
  return (
    <>
      <WorkflowValueChip
        value={selected}
        reference={condition.reference}
        disabled={disabled}
        onOpen={() => setOpen(true)}
      />
      <WorkflowDataPicker
        open={open}
        entries={entries}
        selectedReference={condition.reference}
        refreshing={refreshing}
        compatibility={(entry) =>
          schemaTypes(entry).some((type) =>
            ["string", "number", "integer", "boolean", "null"].includes(type),
          )
            ? { compatible: true }
            : { compatible: false, reason: "Branch conditions require a scalar value." }
        }
        onClose={() => setOpen(false)}
        onSelect={(entry) => {
          onChange(entry);
          setOpen(false);
        }}
      />
    </>
  );
}

function LiteralEditor({
  condition,
  entry,
  disabled,
  onChange,
}: {
  condition: WorkflowBranchConditionV2;
  entry: WorkflowDataCatalogEntry;
  disabled: boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  const enumValues = (Array.isArray(entry.schema.enum) ? entry.schema.enum : []).filter(
    (value): value is string | number | boolean =>
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean",
  );
  if (enumValues.length > 0) {
    return (
      <select
        aria-label="Comparison value"
        className={inputClass}
        disabled={disabled}
        value={JSON.stringify(condition.value)}
        onChange={(event) => onChange(JSON.parse(event.target.value))}
      >
        {enumValues.map((value) => (
          <option key={JSON.stringify(value)} value={JSON.stringify(value)}>
            {String(value)}
          </option>
        ))}
      </select>
    );
  }
  const types = schemaTypes(entry);
  if (types.includes("boolean")) {
    return (
      <select
        aria-label="Comparison value"
        className={inputClass}
        disabled={disabled}
        value={condition.value === false ? "false" : "true"}
        onChange={(event) => onChange(event.target.value === "true")}
      >
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }
  if (types.includes("number") || types.includes("integer")) {
    return (
      <input
        aria-label="Comparison value"
        className={inputClass}
        disabled={disabled}
        type="number"
        value={typeof condition.value === "number" ? condition.value : ""}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    );
  }
  return (
    <input
      aria-label="Comparison value"
      className={inputClass}
      disabled={disabled}
      value={typeof condition.value === "string" ? condition.value : ""}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function BranchFields({
  configuration,
  availableValues,
  valuesRefreshing = false,
  canEdit,
  onChange,
}: {
  configuration: Readonly<Record<string, JsonValue>>;
  availableValues: readonly WorkflowDataCatalogEntry[];
  valuesRefreshing?: boolean;
  canEdit: boolean;
  onChange: (configuration: WorkflowBranchConfigurationV2) => void;
}) {
  const parsed = parseConfiguration(configuration);
  const replace = () =>
    onChange({ combinator: "all", conditions: [] });
  if (!parsed) {
    return (
      <section className="border-t border-red-200 bg-red-50 px-[14px] py-3">
        <p className="m-0 font-body text-[11px] text-red-800">
          This pre-release Branch uses an obsolete configuration.
        </p>
        {canEdit && (
          <button type="button" className={`${buttonClass} mt-2`} onClick={replace}>
            Replace condition
          </button>
        )}
      </section>
    );
  }
  return (
    <section className="border-t border-neutral-200">
      <div className="border-b border-neutral-200 bg-app-bg px-[14px] py-2">
        <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
          Branch decision
        </div>
        <p className="m-0 mt-1 font-body text-[11px] text-neutral-600">
          Continue through True when {parsed.combinator === "all" ? "all" : "any"} conditions match.
        </p>
      </div>
      <div className="border-b border-neutral-200 px-[14px] py-3">
        <label className="mb-3 flex items-center gap-2 font-body text-[11px]">
          Match
          <select
            className={inputClass}
            disabled={!canEdit}
            value={parsed.combinator}
            onChange={(event) =>
              onChange({
                ...parsed,
                combinator: event.target.value as "all" | "any",
              })
            }
          >
            <option value="all">all conditions (AND)</option>
            <option value="any">any condition (OR)</option>
          </select>
        </label>
        <div className="space-y-3">
          {parsed.conditions.map((condition, index) => {
            const entry =
              availableValues.find(
                (candidate) => candidate.reference === condition.reference,
              ) ?? null;
            const presence =
              condition.operator === "has_value" ||
              condition.operator === "has_no_value";
            const text =
              entry ? schemaTypes(entry).includes("string") : false;
            return (
              <div key={index} className="space-y-2 rounded-[3px] border border-neutral-200 bg-panel p-2.5">
                <ReferencePicker
                  condition={condition}
                  entries={availableValues}
                  refreshing={valuesRefreshing}
                  disabled={!canEdit}
                  onChange={(nextEntry) => {
                    const next = {
                      reference: nextEntry.reference,
                      operator: "equals" as const,
                      value: defaultValue(nextEntry),
                    };
                    onChange({
                      ...parsed,
                      conditions: parsed.conditions.map((item, itemIndex) =>
                        itemIndex === index ? next : item,
                      ),
                    });
                  }}
                />
                {entry && (
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                    <select
                      aria-label="Operator"
                      className={inputClass}
                      disabled={!canEdit}
                      value={condition.operator}
                      onChange={(event) => {
                        const operator = event.target.value as WorkflowBranchOperatorV2;
                        const isPresence =
                          operator === "has_value" || operator === "has_no_value";
                        const next: WorkflowBranchConditionV2 = isPresence
                          ? { reference: condition.reference, operator }
                          : {
                              reference: condition.reference,
                              operator,
                              value: condition.value ?? defaultValue(entry),
                            };
                        onChange({
                          ...parsed,
                          conditions: parsed.conditions.map((item, itemIndex) =>
                            itemIndex === index ? next : item,
                          ),
                        });
                      }}
                    >
                      {operators(entry).map((operator) => (
                        <option key={operator} value={operator}>
                          {operator.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                    {!presence && (
                      <LiteralEditor
                        condition={condition}
                        entry={entry}
                        disabled={!canEdit}
                        onChange={(value) =>
                          onChange({
                            ...parsed,
                            conditions: parsed.conditions.map((item, itemIndex) =>
                              itemIndex === index ? { ...condition, value } : item,
                            ),
                          })
                        }
                      />
                    )}
                    <button
                      type="button"
                      aria-label="Delete condition"
                      disabled={!canEdit}
                      className="h-9 w-9 border-none bg-transparent text-neutral-500"
                      onClick={() =>
                        onChange({
                          ...parsed,
                          conditions: parsed.conditions.filter((_, itemIndex) => itemIndex !== index),
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                )}
                {entry && text && !presence && (
                  <label className="flex items-center gap-2 font-body text-[11px] text-neutral-600">
                    <input
                      type="checkbox"
                      checked={condition.ignoreCase === true}
                      disabled={!canEdit}
                      onChange={(event) =>
                        onChange({
                          ...parsed,
                          conditions: parsed.conditions.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...condition, ignoreCase: event.target.checked }
                              : item,
                          ),
                        })
                      }
                    />
                    Ignore capitalization
                  </label>
                )}
              </div>
            );
          })}
        </div>
        {canEdit && (
          <button
            type="button"
            className={`${buttonClass} mt-3`}
            disabled={!availableValues.some((entry) => entry.availability.state === "available")}
            onClick={() => {
              const entry = availableValues.find(
                (candidate) => candidate.availability.state === "available",
              );
              if (!entry) return;
              onChange({
                ...parsed,
                conditions: [
                  ...parsed.conditions,
                  {
                    reference: entry.reference as WorkflowDataReferenceV2,
                    operator: "equals",
                    value: defaultValue(entry),
                  },
                ],
              });
            }}
          >
            Add condition
          </button>
        )}
      </div>
    </section>
  );
}
