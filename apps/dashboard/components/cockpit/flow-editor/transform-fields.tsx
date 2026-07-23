"use client";

import { useState } from "react";
import type {
  JsonValue,
  TransformComparisonOperator,
  TransformConfiguration,
  TransformMapField,
  TransformPredicate,
} from "@shared/contracts";

const inputClass =
  "h-[28px] min-w-0 px-2 bg-off-white border border-neutral-200 rounded-xs font-mono text-[11px] text-coal outline-none disabled:opacity-60";
const buttonClass =
  "appearance-none cursor-pointer border border-neutral-200 bg-panel h-[28px] px-2 rounded-xs font-mono text-[10px] uppercase tracking-[0.04em] text-coal disabled:opacity-40 disabled:cursor-default";

const operators: Array<{ value: TransformComparisonOperator; label: string }> = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "greater_than", label: "is greater than" },
  { value: "greater_than_or_equal", label: "is at least" },
  { value: "less_than", label: "is less than" },
  { value: "less_than_or_equal", label: "is at most" },
];

export function transformPathFromText(value: string): string[] {
  return value
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function transformPathToText(path: readonly string[]): string {
  return path.join(".");
}

export function defaultTransformPredicate(): TransformPredicate {
  return { kind: "comparison", path: [], operator: "equals", value: "" };
}

export function defaultTransformConfiguration(
  operation: TransformConfiguration["operation"],
  inputName = "",
): TransformConfiguration {
  return operation === "map_object"
    ? {
        operation,
        fields: [
          {
            name: "value",
            value: {
              kind: "input",
              source: { input: inputName, path: [] },
            },
          },
        ],
      }
    : {
        operation,
        source: { input: inputName, path: [] },
        predicate: defaultTransformPredicate(),
      };
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[9px] text-neutral-700 tracking-[0.04em] uppercase">
      {children}
    </span>
  );
}

function InputPicker({
  value,
  inputNames,
  disabled,
  onChange,
}: {
  value: string;
  inputNames: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const options = inputNames.includes(value) || value === "" ? inputNames : [value, ...inputNames];
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label="Transform input"
      onChange={(event) => onChange(event.target.value)}
      className={inputClass}
    >
      <option value="">Select input…</option>
      {options.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}

function JsonValueInput({
  value,
  disabled,
  optional = false,
  onChange,
}: {
  value: JsonValue | undefined;
  disabled: boolean;
  optional?: boolean;
  onChange: (value: JsonValue | undefined) => void;
}) {
  const serialized = value === undefined ? "" : JSON.stringify(value);
  const [seed, setSeed] = useState(serialized);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  if (serialized !== seed) {
    setSeed(serialized);
    setText(serialized);
    setError(null);
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <input
        value={text}
        disabled={disabled}
        placeholder={optional ? "No default" : 'JSON value, for example "ready"'}
        aria-invalid={error !== null}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (optional && next.trim() === "") {
            setError(null);
            onChange(undefined);
            return;
          }
          try {
            const parsed = JSON.parse(next) as JsonValue;
            setError(null);
            onChange(parsed);
          } catch {
            setError("Enter a valid JSON value.");
          }
        }}
        className={`${inputClass} ${error ? "border-red-500" : ""}`}
      />
      {error && (
        <span role="alert" className="font-body text-[10px] text-red-700">
          {error}
        </span>
      )}
    </div>
  );
}

function SourcePathFields({
  input,
  path,
  inputNames,
  disabled,
  onChange,
}: {
  input: string;
  path: string[];
  inputNames: string[];
  disabled: boolean;
  onChange: (source: { input: string; path: string[] }) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="flex min-w-0 flex-col gap-1">
        <FieldLabel>Input</FieldLabel>
        <InputPicker
          value={input}
          inputNames={inputNames}
          disabled={disabled}
          onChange={(next) => onChange({ input: next, path })}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1">
        <FieldLabel>Field path</FieldLabel>
        <input
          value={transformPathToText(path)}
          disabled={disabled}
          placeholder="Whole value"
          onChange={(event) =>
            onChange({ input, path: transformPathFromText(event.target.value) })
          }
          className={inputClass}
        />
      </label>
    </div>
  );
}

function MapFieldEditor({
  field,
  inputNames,
  disabled,
  onChange,
  onDelete,
}: {
  field: TransformMapField;
  inputNames: string[];
  disabled: boolean;
  onChange: (field: TransformMapField) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-neutral-200 px-[14px] py-3">
      <div className="flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <FieldLabel>Output field</FieldLabel>
          <input
            value={field.name}
            disabled={disabled}
            placeholder="fieldName"
            onChange={(event) => onChange({ ...field, name: event.target.value })}
            className={inputClass}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <FieldLabel>Value from</FieldLabel>
          <select
            value={field.value.kind}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...field,
                value:
                  event.target.value === "literal"
                    ? { kind: "literal", value: "" }
                    : {
                        kind: "input",
                        source: { input: inputNames[0] ?? "", path: [] },
                      },
              })
            }
            className={inputClass}
          >
            <option value="input">Bound input</option>
            <option value="literal">Literal</option>
          </select>
        </label>
        <button
          type="button"
          disabled={disabled}
          onClick={onDelete}
          aria-label={`Remove ${field.name || "map"} field`}
          className={`${buttonClass} text-red-700`}
        >
          ×
        </button>
      </div>
      {field.value.kind === "input" ? (
        <>
          <SourcePathFields
            {...field.value.source}
            inputNames={inputNames}
            disabled={disabled}
            onChange={(source) => {
              if (field.value.kind !== "input") return;
              onChange({ ...field, value: { ...field.value, source } });
            }}
          />
          <label className="flex flex-col gap-1">
            <FieldLabel>Default when absent</FieldLabel>
            <JsonValueInput
              value={field.value.defaultValue}
              optional
              disabled={disabled}
              onChange={(defaultValue) => {
                if (field.value.kind !== "input") return;
                const withoutDefault = { ...field.value };
                delete withoutDefault.defaultValue;
                onChange({
                  ...field,
                  value:
                    defaultValue === undefined
                      ? withoutDefault
                      : { ...withoutDefault, defaultValue },
                });
              }}
            />
          </label>
        </>
      ) : (
        <label className="flex flex-col gap-1">
          <FieldLabel>Literal value</FieldLabel>
          <JsonValueInput
            value={field.value.value}
            disabled={disabled}
            onChange={(value) => {
              if (value !== undefined) {
                onChange({ ...field, value: { kind: "literal", value } });
              }
            }}
          />
        </label>
      )}
    </div>
  );
}

function PredicateEditor({
  predicate,
  disabled,
  depth,
  onChange,
  onDelete,
}: {
  predicate: TransformPredicate;
  disabled: boolean;
  depth: number;
  onChange: (predicate: TransformPredicate) => void;
  onDelete?: () => void;
}) {
  const switchKind = (kind: TransformPredicate["kind"]) => {
    switch (kind) {
      case "comparison":
        onChange(defaultTransformPredicate());
        break;
      case "is_null":
        onChange({ kind, path: [], isNull: true });
        break;
      case "all":
      case "any":
        onChange({ kind, predicates: [defaultTransformPredicate()] });
        break;
      case "not":
        onChange({ kind, predicate: defaultTransformPredicate() });
        break;
    }
  };
  return (
    <div
      className={`flex flex-col gap-2 rounded-xs border border-neutral-200 bg-panel p-2 ${
        depth > 0 ? "ml-2" : ""
      }`}
    >
      <div className="flex gap-2">
        <select
          value={predicate.kind}
          disabled={disabled}
          aria-label="Condition kind"
          onChange={(event) => switchKind(event.target.value as TransformPredicate["kind"])}
          className={`${inputClass} flex-1`}
        >
          <option value="comparison">Compare field</option>
          <option value="is_null">Check null</option>
          <option value="all">All conditions</option>
          <option value="any">Any condition</option>
          <option value="not">Not</option>
        </select>
        {onDelete && (
          <button
            type="button"
            disabled={disabled}
            onClick={onDelete}
            aria-label="Remove condition"
            className={`${buttonClass} text-red-700`}
          >
            ×
          </button>
        )}
      </div>

      {predicate.kind === "comparison" && (
        <div className="grid grid-cols-3 gap-2">
          <label className="flex min-w-0 flex-col gap-1">
            <FieldLabel>Item field</FieldLabel>
            <input
              value={transformPathToText(predicate.path)}
              disabled={disabled}
              placeholder="Whole item"
              onChange={(event) =>
                onChange({
                  ...predicate,
                  path: transformPathFromText(event.target.value),
                })
              }
              className={inputClass}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <FieldLabel>Operator</FieldLabel>
            <select
              value={predicate.operator}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...predicate,
                  operator: event.target.value as TransformComparisonOperator,
                })
              }
              className={inputClass}
            >
              {operators.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <FieldLabel>Value</FieldLabel>
            <JsonValueInput
              value={predicate.value}
              disabled={disabled}
              onChange={(value) => {
                if (value !== undefined) onChange({ ...predicate, value });
              }}
            />
          </label>
        </div>
      )}

      {predicate.kind === "is_null" && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex min-w-0 flex-col gap-1">
            <FieldLabel>Item field</FieldLabel>
            <input
              value={transformPathToText(predicate.path)}
              disabled={disabled}
              placeholder="Whole item"
              onChange={(event) =>
                onChange({
                  ...predicate,
                  path: transformPathFromText(event.target.value),
                })
              }
              className={inputClass}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <FieldLabel>Condition</FieldLabel>
            <select
              value={predicate.isNull ? "null" : "not_null"}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...predicate, isNull: event.target.value === "null" })
              }
              className={inputClass}
            >
              <option value="null">is null</option>
              <option value="not_null">is not null</option>
            </select>
          </label>
        </div>
      )}

      {(predicate.kind === "all" || predicate.kind === "any") && (
        <div className="flex flex-col gap-2">
          {predicate.predicates.map((child, index) => (
            <PredicateEditor
              key={index}
              predicate={child}
              disabled={disabled}
              depth={depth + 1}
              onChange={(next) =>
                onChange({
                  ...predicate,
                  predicates: predicate.predicates.map((value, childIndex) =>
                    childIndex === index ? next : value,
                  ),
                })
              }
              onDelete={
                predicate.predicates.length === 1
                  ? undefined
                  : () =>
                      onChange({
                        ...predicate,
                        predicates: predicate.predicates.filter(
                          (_, childIndex) => childIndex !== index,
                        ),
                      })
              }
            />
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              onChange({
                ...predicate,
                predicates: [...predicate.predicates, defaultTransformPredicate()],
              })
            }
            className={`${buttonClass} self-start`}
          >
            Add condition
          </button>
        </div>
      )}

      {predicate.kind === "not" && (
        <PredicateEditor
          predicate={predicate.predicate}
          disabled={disabled}
          depth={depth + 1}
          onChange={(next) => onChange({ ...predicate, predicate: next })}
        />
      )}
    </div>
  );
}

export function TransformFields({
  configuration,
  inputNames,
  canEdit,
  onChange,
}: {
  configuration: TransformConfiguration;
  inputNames: string[];
  canEdit: boolean;
  onChange: (configuration: TransformConfiguration) => void;
}) {
  return (
    <section className="border-t border-neutral-200">
      <div className="border-b border-neutral-200 bg-app-bg px-[14px] py-2">
        <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
          Transform
        </div>
        <p className="m-0 mt-1 font-body text-[11px] leading-[1.4] text-neutral-600">
          Use one safe, typed operation. Chain Transform blocks for multiple stages.
        </p>
      </div>
      <label className="flex flex-col gap-1 border-b border-neutral-200 px-[14px] py-2.5">
        <FieldLabel>Operation</FieldLabel>
        <select
          value={configuration.operation}
          disabled={!canEdit}
          onChange={(event) =>
            onChange(
              defaultTransformConfiguration(
                event.target.value as TransformConfiguration["operation"],
                inputNames[0],
              ),
            )
          }
          className={inputClass}
        >
          <option value="map_object">Map object</option>
          <option value="filter_array">Filter array</option>
        </select>
      </label>

      {configuration.operation === "map_object" ? (
        <>
          {configuration.fields.map((field, index) => (
            <MapFieldEditor
              key={index}
              field={field}
              inputNames={inputNames}
              disabled={!canEdit}
              onChange={(next) =>
                onChange({
                  ...configuration,
                  fields: configuration.fields.map((value, fieldIndex) =>
                    fieldIndex === index ? next : value,
                  ),
                })
              }
              onDelete={() =>
                onChange({
                  ...configuration,
                  fields: configuration.fields.filter(
                    (_, fieldIndex) => fieldIndex !== index,
                  ),
                })
              }
            />
          ))}
          {canEdit && (
            <div className="border-b border-neutral-200 px-[14px] py-2.5">
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...configuration,
                    fields: [
                      ...configuration.fields,
                      {
                        name: `field${configuration.fields.length + 1}`,
                        value: {
                          kind: "input",
                          source: { input: inputNames[0] ?? "", path: [] },
                        },
                      },
                    ],
                  })
                }
                className={buttonClass}
              >
                Add output field
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-3 border-b border-neutral-200 px-[14px] py-3">
          <SourcePathFields
            {...configuration.source}
            inputNames={inputNames}
            disabled={!canEdit}
            onChange={(source) => onChange({ ...configuration, source })}
          />
          <div className="flex flex-col gap-1">
            <FieldLabel>Keep item when</FieldLabel>
            <PredicateEditor
              predicate={configuration.predicate}
              disabled={!canEdit}
              depth={0}
              onChange={(predicate) => onChange({ ...configuration, predicate })}
            />
          </div>
        </div>
      )}
    </section>
  );
}
