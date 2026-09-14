"use client";

import { useState } from "react";
import type {
  TransformBuildObjectField,
  TransformConfiguration,
  WorkflowDataCatalogEntry,
  WorkflowDataReferenceV2,
} from "@shared/contracts";
import { evaluateWorkflowValueCompatibility } from "@shared/contracts";
import { Button, Checkbox, IconButton, Input, Select } from "@/components/ui";
import { JsonSchemaEditor } from "../json-schema-editor";
import {
  compatibilityInvalidReason,
  WorkflowDataPicker,
  WorkflowValueChip,
} from "../workflow-data-picker";
import { WorkflowTextTemplateEditor } from "../workflow-text-template-editor";
import type { BlockRendererProps } from "./types";

const DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;
const inputClass =
  "h-9 min-w-0 rounded-[3px] border border-neutral-200 bg-off-white px-2.5 font-body text-[12px] text-coal outline-none disabled:opacity-50";
const buttonClass =
  "h-8 rounded-[3px] border border-mariner bg-panel px-3 font-mono text-[9px] uppercase tracking-[0.05em] text-mariner disabled:opacity-40";
type Operation = TransformConfiguration["operation"];

const operationLabels: Record<Operation, string> = {
  format_text: "Format text",
  trim_text: "Trim text",
  replace_text: "Replace text",
  text_to_number: "Text to number",
  number_to_text: "Number to text",
  parse_json: "Parse JSON",
  build_object: "Build object",
};

export function defaultTransformConfiguration(
  operation: Operation,
  reference: WorkflowDataReferenceV2 = "steps.entry.output",
): TransformConfiguration {
  switch (operation) {
    case "format_text":
      return { operation, template: "" };
    case "trim_text":
    case "text_to_number":
    case "number_to_text":
      return { operation, source: reference };
    case "replace_text":
      return {
        operation,
        source: reference,
        mode: "plain",
        pattern: "",
        replacement: "",
        ignoreCase: false,
      };
    case "parse_json":
      return { operation, source: reference };
    case "build_object":
      return { operation, fields: [] };
  }
}

function types(entry: WorkflowDataCatalogEntry): string[] {
  const raw = entry.schema.type;
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string");
  }
  return typeof raw === "string" ? [raw] : [];
}

function SourcePicker({
  value,
  entries,
  refreshing,
  disabled,
  accepts,
  onChange,
}: {
  value: WorkflowDataReferenceV2;
  entries: readonly WorkflowDataCatalogEntry[];
  refreshing: boolean;
  disabled: boolean;
  accepts: "text" | "number" | "any";
  onChange: (reference: WorkflowDataReferenceV2) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = entries.find((entry) => entry.reference === value) ?? null;
  const destination =
    accepts === "any"
      ? ({ kind: "build_object" } as const)
      : ({
          kind:
            accepts === "text"
              ? "transform_text"
              : "transform_number",
        } as const);
  const selectedCompatibility = selected
    ? evaluateWorkflowValueCompatibility(selected, destination)
    : null;
  return (
    <>
      <WorkflowValueChip
        value={selected}
        reference={value}
        invalidReason={compatibilityInvalidReason(selectedCompatibility)}
        disabled={disabled}
        onOpen={() => setOpen(true)}
      />
      <WorkflowDataPicker
        open={open}
        entries={entries}
        selectedReference={value}
        refreshing={refreshing}
        compatibility={(entry) => {
          return evaluateWorkflowValueCompatibility(entry, destination);
        }}
        onClose={() => setOpen(false)}
        onSelect={(entry) => {
          onChange(entry.reference);
          setOpen(false);
        }}
      />
    </>
  );
}

function OutputShape({ configuration }: { configuration: TransformConfiguration }) {
  const label =
    configuration.operation === "text_to_number" ||
    configuration.operation === "parse_json"
      ? "{ success, value, error }"
      : configuration.operation === "build_object"
        ? `{ ${configuration.fields.map((field) => field.name).filter(Boolean).join(", ")} }`
        : "Text";
  return (
    <div className="border-b border-neutral-200 bg-app-bg px-[14px] py-2.5">
      <span className="font-mono text-[9px] uppercase tracking-[0.05em] text-neutral-500">
        Output shape
      </span>
      <strong className="ml-2 font-mono text-[11px] font-normal text-coal">{label}</strong>
    </div>
  );
}

function ScalarEditor({
  value,
  disabled,
  label,
  onChange,
}: {
  value: string | number | boolean | null;
  disabled: boolean;
  label: string;
  onChange: (value: string | number | boolean | null) => void;
}) {
  const kind = value === null ? "null" : typeof value;
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2">
      <Select
        aria-label={`${label} type`}
        size="compact"
        className={inputClass}
        disabled={disabled}
        value={kind}
        options={[
          { value: "string", label: "Text" },
          { value: "number", label: "Number" },
          { value: "boolean", label: "Boolean" },
          { value: "null", label: "Null" },
        ]}
        onChange={(next) => {
          onChange(
            next === "null"
              ? null
              : next === "number"
                ? 0
                : next === "boolean"
                  ? false
                  : "",
          );
        }}
      />
      {kind === "boolean" ? (
        <Select
          aria-label={label}
          size="compact"
          className={inputClass}
          disabled={disabled}
          value={value === true ? "true" : "false"}
          options={[
            { value: "false", label: "False" },
            { value: "true", label: "True" },
          ]}
          onChange={(next) => onChange(next === "true")}
        />
      ) : kind === "null" ? (
        <Input aria-label={label} size="sm" disabled value="null" className={inputClass} />
      ) : (
        <Input
          aria-label={label}
          size="sm"
          className={inputClass}
          disabled={disabled}
          type={kind === "number" ? "number" : "text"}
          value={String(value)}
          onChange={(event) =>
            onChange(
              kind === "number" ? Number(event.target.value) : event.target.value,
            )
          }
        />
      )}
    </div>
  );
}

function BuildObjectRow({
  field,
  entries,
  refreshing,
  disabled,
  onChange,
  onDelete,
}: {
  field: TransformBuildObjectField;
  entries: readonly WorkflowDataCatalogEntry[];
  refreshing: boolean;
  disabled: boolean;
  onChange: (field: TransformBuildObjectField) => void;
  onDelete: () => void;
}) {
  const referenceValue =
    field.value.kind === "reference" ? field.value : null;
  const literalValue = field.value.kind === "literal" ? field.value : null;
  const selected = referenceValue
    ? entries.find((entry) => entry.reference === referenceValue.reference) ??
      null
    : null;
  const canDefault =
    selected !== null &&
    (selected.presence !== "required" || types(selected).includes("null"));
  return (
    <div className="space-y-2 border-b border-neutral-200 px-[14px] py-3">
      <div className="grid grid-cols-[1fr_120px_auto] gap-2">
        <Input
          aria-label="Output field name"
          size="sm"
          className={inputClass}
          disabled={disabled}
          placeholder="field_name"
          value={field.name}
          onChange={(event) => onChange({ ...field, name: event.target.value })}
        />
        <Select
          aria-label="Value kind"
          size="compact"
          className={inputClass}
          disabled={disabled}
          value={field.value.kind}
          options={[
            { value: "reference", label: "Workflow value" },
            { value: "literal", label: "Literal value" },
          ]}
          onChange={(valueKind) =>
            onChange({
              ...field,
              value:
                valueKind === "literal"
                  ? { kind: "literal", value: "" }
                  : { kind: "reference", reference: "steps.entry.output" },
            })
          }
        />
        <IconButton
          type="button"
          size="sm"
          aria-label="Delete output field"
          disabled={disabled}
          onClick={onDelete}
          className="h-9 w-9 border-none bg-transparent text-neutral-500"
        >
          ×
        </IconButton>
      </div>
      {referenceValue ? (
        <SourcePicker
          value={referenceValue.reference}
          entries={entries}
          refreshing={refreshing}
          disabled={disabled}
          accepts="any"
          onChange={(reference) =>
            onChange({
              ...field,
              value: {
                kind: "reference",
                reference,
                defaultValue: referenceValue.defaultValue,
              },
            })
          }
        />
      ) : literalValue ? (
        <ScalarEditor
          label="Literal value"
          disabled={disabled}
          value={literalValue.value}
          onChange={(value) =>
            onChange({ ...field, value: { kind: "literal", value } })
          }
        />
      ) : null}
      {referenceValue && canDefault && (
        <div className="space-y-2">
          <Checkbox
            disabled={disabled}
            checked={referenceValue.defaultValue !== undefined}
            onChange={(event) =>
              onChange({
                ...field,
                value: {
                  ...referenceValue,
                  defaultValue: event.target.checked ? "" : undefined,
                },
              })
            }
            className="text-[11px] text-neutral-600"
            label="Use a default when missing or null"
          />
          {referenceValue.defaultValue !== undefined && (
            <ScalarEditor
              label="Default value"
              disabled={disabled}
              value={referenceValue.defaultValue}
              onChange={(defaultValue) =>
                onChange({
                  ...field,
                  value: { ...referenceValue, defaultValue },
                })
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

export function TransformFields({
  configuration,
  availableValues,
  valuesRefreshing = false,
  canEdit,
  onChange,
}: {
  configuration: TransformConfiguration;
  availableValues: readonly WorkflowDataCatalogEntry[];
  valuesRefreshing?: boolean;
  canEdit: boolean;
  onChange: (configuration: TransformConfiguration) => void;
}) {
  const firstReference =
    availableValues.find((entry) => entry.availability.state === "available")
      ?.reference ?? "steps.entry.output";
  return (
    <section className="border-t border-neutral-200">
      <div className="border-b border-neutral-200 bg-app-bg px-[14px] py-2">
        <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
          Transform
        </div>
        <p className="m-0 mt-1 font-body text-[11px] text-neutral-600">
          Apply one predictable action. Chain blocks for multiple changes.
        </p>
      </div>
      <label className="flex flex-col gap-1 border-b border-neutral-200 px-[14px] py-2.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.05em] text-neutral-600">
          Action
        </span>
        <Select
          aria-label="Action"
          size="compact"
          className={inputClass}
          value={configuration.operation}
          disabled={!canEdit}
          options={(Object.keys(operationLabels) as Operation[]).map((operation) => ({
            value: operation,
            label: operationLabels[operation],
          }))}
          onChange={(operation) =>
            onChange(
              defaultTransformConfiguration(
                operation as Operation,
                firstReference,
              ),
            )
          }
        />
      </label>

      {configuration.operation === "format_text" && (
        <div className="border-b border-neutral-200 px-[14px] py-3">
          <WorkflowTextTemplateEditor
            value={configuration.template}
            entries={availableValues}
            disabled={!canEdit}
            refreshing={valuesRefreshing}
            onChange={(template) => onChange({ ...configuration, template })}
          />
        </div>
      )}
      {configuration.operation !== "format_text" &&
        configuration.operation !== "build_object" && (
          <div className="space-y-3 border-b border-neutral-200 px-[14px] py-3">
            <SourcePicker
              value={configuration.source}
              entries={availableValues}
              refreshing={valuesRefreshing}
              disabled={!canEdit}
              accepts={
                configuration.operation === "number_to_text" ? "number" : "text"
              }
              onChange={(source) => onChange({ ...configuration, source })}
            />
            {configuration.operation === "replace_text" && (
              <>
                <Select
                  aria-label="Match mode"
                  size="compact"
                  className={`${inputClass} w-full`}
                  disabled={!canEdit}
                  value={configuration.mode}
                  options={[
                    { value: "plain", label: "Plain text" },
                    { value: "regex", label: "Regular expression" },
                  ]}
                  onChange={(mode) =>
                    onChange({
                      ...configuration,
                      mode: mode as "plain" | "regex",
                    })
                  }
                />
                <Input
                  aria-label="Find"
                  size="sm"
                  className={`${inputClass} w-full`}
                  disabled={!canEdit}
                  placeholder={configuration.mode === "regex" ? "RE2 pattern" : "Text to find"}
                  value={configuration.pattern}
                  onChange={(event) =>
                    onChange({ ...configuration, pattern: event.target.value })
                  }
                />
                <Input
                  aria-label="Replace with"
                  size="sm"
                  className={`${inputClass} w-full`}
                  disabled={!canEdit}
                  placeholder="Replacement text"
                  value={configuration.replacement}
                  onChange={(event) =>
                    onChange({ ...configuration, replacement: event.target.value })
                  }
                />
                <Checkbox
                  checked={configuration.ignoreCase}
                  disabled={!canEdit}
                  onChange={(event) =>
                    onChange({ ...configuration, ignoreCase: event.target.checked })
                  }
                  className="text-[11px] text-neutral-600"
                  label="Ignore capitalization"
                />
                {configuration.mode === "regex" && (
                  <p className="m-0 font-body text-[10px] text-neutral-500">
                    Uses safe RE2 syntax. Replacement is always literal.
                  </p>
                )}
              </>
            )}
            {configuration.operation === "parse_json" && (
              <>
                <Checkbox
                  checked={configuration.expectedSchema !== undefined}
                  disabled={!canEdit}
                  onChange={(event) =>
                    onChange({
                      ...configuration,
                      expectedSchema: event.target.checked
                        ? {
                            dialect: DIALECT,
                            source: JSON.stringify({
                              $schema: DIALECT,
                              type: "object",
                              properties: {},
                              required: [],
                              additionalProperties: false,
                            }, null, 2),
                          }
                        : undefined,
                    })
                  }
                  className="text-[11px] text-neutral-600"
                  label="Validate the parsed value against a schema"
                />
                {configuration.expectedSchema && (
                  <JsonSchemaEditor
                    value={configuration.expectedSchema.source}
                    disabled={!canEdit}
                    label="Expected JSON schema"
                    onChange={(source) =>
                      onChange({
                        ...configuration,
                        expectedSchema: { dialect: DIALECT, source },
                      })
                    }
                  />
                )}
              </>
            )}
          </div>
        )}
      {configuration.operation === "build_object" && (
        <>
          {configuration.fields.map((field, index) => (
            <BuildObjectRow
              key={index}
              field={field}
              entries={availableValues}
              refreshing={valuesRefreshing}
              disabled={!canEdit}
              onChange={(next) =>
                onChange({
                  ...configuration,
                  fields: configuration.fields.map((item, itemIndex) =>
                    itemIndex === index ? next : item,
                  ),
                })
              }
              onDelete={() =>
                onChange({
                  ...configuration,
                  fields: configuration.fields.filter((_, itemIndex) => itemIndex !== index),
                })
              }
            />
          ))}
          {canEdit && (
            <div className="border-b border-neutral-200 px-[14px] py-3">
              <Button
                type="button"
                size="sm"
                className={buttonClass}
                onClick={() =>
                  onChange({
                    ...configuration,
                    fields: [
                      ...configuration.fields,
                      {
                        name: `field_${configuration.fields.length + 1}`,
                        value: { kind: "reference", reference: firstReference },
                      },
                    ],
                  })
                }
              >
                Add field
              </Button>
            </div>
          )}
        </>
      )}
      <OutputShape configuration={configuration} />
    </section>
  );
}

export function TransformConfigFields(_props: BlockRendererProps) {
  return null;
}
