"use client";

import { createContext, useContext, useState } from "react";
import type {
  JsonSchema202012,
  JsonValue,
  WorkflowDataCatalogEntry,
  WorkflowBranchBooleanAstV2,
  WorkflowBranchConfigurationV2,
  WorkflowBranchOperandV2,
  WorkflowDataReferenceV2,
} from "@shared/contracts";
import {
  branchConditionForKind,
  branchLiteralForSchema,
  branchSchemaForOperand,
  defaultWorkflowBranchCondition,
  isBooleanWorkflowValue,
  parseWorkflowBranchConfigurationV2,
} from "@/lib/workflow-editor/branch-ast";
import {
  WorkflowDataPicker,
  WorkflowValueChip,
} from "./workflow-data-picker";

const inputClass =
  "h-[28px] min-w-0 rounded-xs border border-neutral-200 bg-off-white px-2 font-mono text-[10px] text-coal outline-none disabled:opacity-60";
const buttonClass =
  "h-[28px] appearance-none rounded-xs border border-mariner bg-panel px-2 font-mono text-[10px] uppercase tracking-[0.04em] text-mariner disabled:cursor-default disabled:opacity-40";
const BranchValuesRefreshingContext = createContext(false);

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-700">
      {children}
    </span>
  );
}

function PathPicker({
  value,
  availableValues,
  booleanOnly,
  disabled,
  label,
  onChange,
}: {
  value: WorkflowDataReferenceV2;
  availableValues: readonly WorkflowDataCatalogEntry[];
  booleanOnly?: boolean;
  disabled: boolean;
  label: string;
  onChange: (reference: WorkflowDataReferenceV2) => void;
}) {
  const [open, setOpen] = useState(false);
  const refreshing = useContext(BranchValuesRefreshingContext);
  const current = availableValues.find(
    (candidate) => candidate.reference === value,
  );
  return (
    <>
      <span className="sr-only">{label}</span>
      <WorkflowValueChip
        value={current ?? null}
        reference={value}
        disabled={disabled}
        onOpen={() => setOpen(true)}
      />
      <WorkflowDataPicker
        open={open}
        entries={availableValues}
        selectedReference={value}
        refreshing={refreshing}
        compatibility={(entry) =>
          !booleanOnly || isBooleanWorkflowValue(entry)
            ? { compatible: true }
            : {
                compatible: false,
                reason: "This condition requires a boolean value.",
              }
        }
        onClose={() => setOpen(false)}
        onSelect={(entry) => {
          onChange(entry.reference);
          setOpen(false);
        }}
      />
    </>
  );
}

function scalarEnum(schema: JsonSchema202012 | undefined) {
  const values = Array.isArray(schema?.enum) ? schema.enum : [];
  return values.filter(
    (value): value is string | number | boolean | null =>
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean",
  );
}

function literalType(
  value: WorkflowBranchOperandV2 & { kind: "lit" },
  schema: JsonSchema202012 | undefined,
): "string" | "number" | "boolean" | "null" {
  const schemaTypes = Array.isArray(schema?.type)
    ? schema.type
    : typeof schema?.type === "string"
      ? [schema.type]
      : [];
  if (schemaTypes.includes("string")) return "string";
  if (schemaTypes.includes("number") || schemaTypes.includes("integer")) {
    return "number";
  }
  if (schemaTypes.includes("boolean")) return "boolean";
  if (schemaTypes.includes("null")) return "null";
  if (value.value === null) return "null";
  if (typeof value.value === "number") return "number";
  if (typeof value.value === "boolean") return "boolean";
  return "string";
}

function LiteralField({
  operand,
  schema,
  disabled,
  label,
  onChange,
}: {
  operand: WorkflowBranchOperandV2 & { kind: "lit" };
  schema: JsonSchema202012 | undefined;
  disabled: boolean;
  label: string;
  onChange: (operand: WorkflowBranchOperandV2 & { kind: "lit" }) => void;
}) {
  const enumValues = scalarEnum(schema);
  if (enumValues.length > 0) {
    const encoded = JSON.stringify(operand.value);
    const inEnum = enumValues.some((value) => JSON.stringify(value) === encoded);
    return (
      <select
        aria-label={label}
        value={encoded}
        disabled={disabled}
        onChange={(event) =>
          onChange({
            kind: "lit",
            value: JSON.parse(event.target.value) as
              | string
              | number
              | boolean
              | null,
          })
        }
        className={`${inputClass} w-full`}
      >
        {!inEnum && <option value={encoded}>Unavailable value: {encoded}</option>}
        {enumValues.map((value) => {
          const valueJson = JSON.stringify(value);
          return (
            <option key={valueJson} value={valueJson}>
              {value === null ? "null" : String(value)}
            </option>
          );
        })}
      </select>
    );
  }

  switch (literalType(operand, schema)) {
    case "boolean":
      return (
        <select
          aria-label={label}
          value={operand.value === true ? "true" : "false"}
          disabled={disabled}
          onChange={(event) =>
            onChange({ kind: "lit", value: event.target.value === "true" })
          }
          className={`${inputClass} w-full`}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    case "number":
      return (
        <input
          aria-label={label}
          type="number"
          value={typeof operand.value === "number" ? operand.value : 0}
          disabled={disabled}
          onChange={(event) =>
            onChange({ kind: "lit", value: Number(event.target.value) })
          }
          className={`${inputClass} w-full`}
        />
      );
    case "null":
      return (
        <input
          aria-label={label}
          value="null"
          disabled
          className={`${inputClass} w-full`}
        />
      );
    case "string":
      return (
        <input
          aria-label={label}
          value={typeof operand.value === "string" ? operand.value : ""}
          disabled={disabled}
          onChange={(event) =>
            onChange({ kind: "lit", value: event.target.value })
          }
          className={`${inputClass} w-full`}
        />
      );
  }
}

function OperandEditor({
  operand,
  otherOperand,
  availableValues,
  valuesRefreshing = false,
  disabled,
  label,
  onChange,
}: {
  operand: WorkflowBranchOperandV2;
  otherOperand: WorkflowBranchOperandV2;
  availableValues: readonly WorkflowDataCatalogEntry[];
  valuesRefreshing?: boolean;
  disabled: boolean;
  label: string;
  onChange: (operand: WorkflowBranchOperandV2) => void;
}) {
  const otherSchema = branchSchemaForOperand(otherOperand, availableValues);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      <select
        aria-label={`${label} kind`}
        value={operand.kind}
        disabled={disabled}
        onChange={(event) => {
          if (event.target.value === "path") {
            const first = availableValues[0];
            if (first) onChange({ kind: "path", reference: first.reference });
          } else {
            onChange({
              kind: "lit",
              value: branchLiteralForSchema(otherSchema),
            });
          }
        }}
        className={`${inputClass} w-full`}
      >
        <option value="path" disabled={availableValues.length === 0}>
          Workflow value
        </option>
        <option value="lit">Literal value</option>
      </select>
      {operand.kind === "path" ? (
        <PathPicker
          value={operand.reference}
          availableValues={availableValues}
          disabled={disabled}
          label={`${label} workflow value`}
          onChange={(reference) => onChange({ kind: "path", reference })}
        />
      ) : (
        <LiteralField
          operand={operand}
          schema={otherSchema}
          disabled={disabled}
          label={`${label} literal value`}
          onChange={onChange}
        />
      )}
    </div>
  );
}

function ConditionEditor({
  condition,
  availableValues,
  disabled,
  depth,
  onChange,
}: {
  condition: WorkflowBranchBooleanAstV2;
  availableValues: readonly WorkflowDataCatalogEntry[];
  disabled: boolean;
  depth: number;
  onChange: (condition: WorkflowBranchBooleanAstV2) => void;
}) {
  const hasBooleanPath =
    condition.kind === "path" ||
    availableValues.some((value) => isBooleanWorkflowValue(value));
  return (
    <div
      className={`flex flex-col gap-2 rounded-xs border border-neutral-200 bg-panel p-2 ${
        depth > 0 ? "ml-2" : ""
      }`}
    >
      <label className="flex min-w-0 flex-col gap-1">
        <FieldLabel>{depth === 0 ? "Condition" : "Nested condition"}</FieldLabel>
        <select
          aria-label={depth === 0 ? "Branch condition kind" : "Nested condition kind"}
          value={condition.kind}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              branchConditionForKind(
                event.target.value as WorkflowBranchBooleanAstV2["kind"],
                availableValues,
              ),
            )
          }
          className={`${inputClass} w-full`}
        >
          <option value="path" disabled={!hasBooleanPath}>
            Boolean workflow value
          </option>
          <option value="eq">Values are equal</option>
          <option value="neq">Values are not equal</option>
          <option value="and">All conditions</option>
          <option value="or">Any condition</option>
          <option value="not">Not</option>
          <option value="lit">Always true or false</option>
        </select>
      </label>

      {condition.kind === "lit" && (
        <label className="flex min-w-0 flex-col gap-1">
          <FieldLabel>Result</FieldLabel>
          <select
            aria-label="Branch fixed result"
            value={condition.value ? "true" : "false"}
            disabled={disabled}
            onChange={(event) =>
              onChange({ kind: "lit", value: event.target.value === "true" })
            }
            className={`${inputClass} w-full`}
          >
            <option value="true">Always true</option>
            <option value="false">Always false</option>
          </select>
        </label>
      )}

      {condition.kind === "path" && (
        <PathPicker
          value={condition.reference}
          availableValues={availableValues}
          booleanOnly
          disabled={disabled}
          label="Boolean workflow value"
          onChange={(reference) => onChange({ kind: "path", reference })}
        />
      )}

      {(condition.kind === "eq" || condition.kind === "neq") && (
        <div className="grid grid-cols-2 gap-2">
          <OperandEditor
            operand={condition.left}
            otherOperand={condition.right}
            availableValues={availableValues}
            disabled={disabled}
            label="Left value"
            onChange={(left) => onChange({ ...condition, left })}
          />
          <OperandEditor
            operand={condition.right}
            otherOperand={condition.left}
            availableValues={availableValues}
            disabled={disabled}
            label="Right value"
            onChange={(right) => onChange({ ...condition, right })}
          />
        </div>
      )}

      {(condition.kind === "and" || condition.kind === "or") && (
        <div className="flex flex-col gap-2">
          <ConditionEditor
            condition={condition.left}
            availableValues={availableValues}
            disabled={disabled}
            depth={depth + 1}
            onChange={(left) => onChange({ ...condition, left })}
          />
          <ConditionEditor
            condition={condition.right}
            availableValues={availableValues}
            disabled={disabled}
            depth={depth + 1}
            onChange={(right) => onChange({ ...condition, right })}
          />
        </div>
      )}

      {condition.kind === "not" && (
        <ConditionEditor
          condition={condition.operand}
          availableValues={availableValues}
          disabled={disabled}
          depth={depth + 1}
          onChange={(operand) => onChange({ ...condition, operand })}
        />
      )}
    </div>
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
  const parsed = parseWorkflowBranchConfigurationV2(configuration);
  return (
    <BranchValuesRefreshingContext.Provider value={valuesRefreshing}>
    <section className="border-t border-neutral-200">
      <div className="border-b border-neutral-200 bg-app-bg px-[14px] py-2">
        <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
          Branch decision
        </div>
        <p className="m-0 mt-1 font-body text-[11px] leading-[1.4] text-neutral-600">
          Build a typed condition from values guaranteed to exist here.
        </p>
      </div>
      {parsed ? (
        <div className="border-b border-neutral-200 px-[14px] py-3">
          <ConditionEditor
            condition={parsed.condition}
            availableValues={availableValues}
            disabled={!canEdit}
            depth={0}
            onChange={(condition) => onChange({ condition })}
          />
        </div>
      ) : (
        <div
          data-branch-configuration="preserved-invalid"
          className="border-b border-red-200 bg-red-50 px-[14px] py-3"
        >
          <p className="m-0 font-body text-[11px] leading-[1.45] text-red-800">
            This saved condition cannot be edited visually. It remains unchanged until
            you replace it.
          </p>
          {canEdit && (
            <button
              type="button"
              className={`${buttonClass} mt-2`}
              onClick={() =>
                onChange({
                  condition: defaultWorkflowBranchCondition(availableValues),
                })
              }
            >
              Replace with visual condition
            </button>
          )}
        </div>
      )}
    </section>
    </BranchValuesRefreshingContext.Provider>
  );
}
