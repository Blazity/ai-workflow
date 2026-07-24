"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  JsonSchema202012,
  JsonSchemaAuthoringInspectionResponse,
  JsonValue,
} from "@shared/contracts";
import {
  DEFAULT_VISUAL_JSON_SCHEMA,
  addVisualSchemaProperty,
  changeVisualSchemaType,
  removeVisualSchemaProperty,
  renameVisualSchemaProperty,
  setVisualSchemaAdditionalProperties,
  setVisualSchemaArrayItems,
  setVisualSchemaDescription,
  setVisualSchemaEnum,
  setVisualSchemaNullable,
  setVisualSchemaProperty,
  setVisualSchemaPropertyRequired,
  valueForExactSchemaSource,
  visualSchemaNullable,
  visualSchemaType,
  type VisualJsonSchemaType,
} from "@/lib/workflow-editor/json-schema-authoring";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const fieldClass =
  "min-w-0 rounded-xs border border-neutral-200 bg-off-white px-2 py-1 font-mono text-[10px] text-coal outline-none focus:border-mariner disabled:opacity-60";
const schemaTypes: VisualJsonSchemaType[] = [
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "null",
];

export type JsonSchemaEditorValidationState =
  | "checking"
  | "valid"
  | "invalid";

async function inspectSchemaSource(
  source: string,
  signal: AbortSignal,
): Promise<JsonSchemaAuthoringInspectionResponse> {
  const response = await fetch("/api/json-schema/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Schema inspection failed (${response.status})`);
  }
  return (await response.json()) as JsonSchemaAuthoringInspectionResponse;
}

function enumSource(value: JsonValue[] | undefined): string {
  return JSON.stringify(value ?? [], null, 2);
}

function EnumField({
  value,
  defaultValue,
  disabled,
  onChange,
}: {
  value: JsonValue[] | undefined;
  defaultValue: JsonValue[];
  disabled: boolean;
  onChange: (value: JsonValue[] | null) => void;
}) {
  const [draft, setDraft] = useState(enumSource(value));
  const [error, setError] = useState<string | null>(null);
  const serialized = enumSource(value);
  useEffect(() => {
    setDraft(serialized);
    setError(null);
  }, [serialized]);

  const commit = () => {
    try {
      const parsed = JSON.parse(draft) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not an array");
      onChange(parsed as JsonValue[]);
      setError(null);
    } catch {
      setError("Enum values must be a JSON array.");
    }
  };

  return (
    <div className="mt-1.5">
      <label className="flex items-center gap-1.5 font-body text-[10px] text-neutral-700">
        <input
          type="checkbox"
          checked={value !== undefined}
          disabled={disabled}
          onChange={(event) =>
            onChange(event.target.checked ? defaultValue : null)
          }
          className="h-3 w-3 accent-mariner"
        />
        Restrict to enum values
      </label>
      {value !== undefined && (
        <>
          <textarea
            aria-label="Enum values"
            value={draft}
            disabled={disabled}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            className={`${fieldClass} mt-1 w-full resize-y`}
          />
          {error && (
            <p className="m-0 mt-1 font-body text-[10px] text-red-700">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function PropertyNameField({
  value,
  siblingNames,
  disabled,
  onCommit,
}: {
  value: string;
  siblingNames: ReadonlySet<string>;
  disabled: boolean;
  onCommit: (value: string) => boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);
  const commit = () => {
    if (draft === value) return;
    if (siblingNames.has(draft) || !onCommit(draft)) {
      setError("Use a unique name made from letters, numbers, _ or -.");
      return;
    }
    setError(null);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commit();
    event.currentTarget.blur();
  };
  return (
    <div className="min-w-0 flex-1">
      <input
        aria-label={`Property name ${value}`}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={keyDown}
        className={`${fieldClass} w-full`}
      />
      {error && (
        <p className="m-0 mt-1 font-body text-[9px] text-red-700">{error}</p>
      )}
    </div>
  );
}

function schemaProperties(
  schema: JsonSchema202012,
): Record<string, JsonSchema202012> {
  return schema.properties !== null &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
    ? (schema.properties as Record<string, JsonSchema202012>)
    : {};
}

function defaultEnumValues(type: VisualJsonSchemaType): JsonValue[] {
  switch (type) {
    case "object":
      return [{}];
    case "array":
      return [[]];
    case "string":
      return [""];
    case "number":
      return [0];
    case "boolean":
      return [true, false];
    case "null":
      return [null];
  }
}

function SchemaNodeEditor({
  schema,
  disabled,
  depth,
  pathLabel,
  onChange,
}: {
  schema: JsonSchema202012;
  disabled: boolean;
  depth: number;
  pathLabel: string;
  onChange: (schema: JsonSchema202012) => void;
}) {
  const [newProperty, setNewProperty] = useState("");
  const [newPropertyError, setNewPropertyError] = useState<string | null>(null);
  const type = visualSchemaType(schema) ?? "string";
  const nullable = visualSchemaNullable(schema);
  const properties = schemaProperties(schema);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  const enumValues = Array.isArray(schema.enum)
    ? (schema.enum as JsonValue[])
    : undefined;

  return (
    <div
      className={
        depth === 0
          ? "space-y-2"
          : "mt-2 space-y-2 border-l border-neutral-200 pl-2"
      }
    >
      <div className="flex items-center gap-1.5">
        <select
          aria-label={`${pathLabel} type`}
          value={type}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              changeVisualSchemaType(
                schema,
                event.target.value as VisualJsonSchemaType,
              ),
            )
          }
          className={`${fieldClass} flex-1`}
        >
          {schemaTypes.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 font-body text-[10px] text-neutral-700">
          <input
            type="checkbox"
            checked={nullable}
            disabled={disabled || type === "null"}
            onChange={(event) =>
              onChange(setVisualSchemaNullable(schema, event.target.checked))
            }
            className="h-3 w-3 accent-mariner"
          />
          Nullable
        </label>
      </div>
      <input
        aria-label={`${pathLabel} description`}
        value={typeof schema.description === "string" ? schema.description : ""}
        disabled={disabled}
        placeholder="Description (optional)"
        onChange={(event) =>
          onChange(setVisualSchemaDescription(schema, event.target.value))
        }
        className={`${fieldClass} w-full font-body`}
      />

      <EnumField
        value={enumValues}
        defaultValue={defaultEnumValues(type)}
        disabled={disabled}
        onChange={(values) => onChange(setVisualSchemaEnum(schema, values))}
      />

      {type === "object" && (
        <div className="space-y-2">
          <label className="flex items-center gap-1.5 font-body text-[10px] text-neutral-700">
            <input
              type="checkbox"
              checked={schema.additionalProperties !== false}
              disabled={disabled}
              onChange={(event) =>
                onChange(
                  setVisualSchemaAdditionalProperties(
                    schema,
                    event.target.checked,
                  ),
                )
              }
              className="h-3 w-3 accent-mariner"
            />
            Allow fields not listed below
          </label>
          {Object.entries(properties).map(([name, child]) => {
            const siblingNames = new Set(Object.keys(properties));
            siblingNames.delete(name);
            return (
              <div
                key={name}
                className="rounded-xs border border-neutral-200 bg-panel p-2"
              >
                <div className="flex items-start gap-1.5">
                  <PropertyNameField
                    value={name}
                    siblingNames={siblingNames}
                    disabled={disabled}
                    onCommit={(nextName) => {
                      const next = renameVisualSchemaProperty(
                        schema,
                        name,
                        nextName,
                      );
                      if (!next) return false;
                      onChange(next);
                      return true;
                    }}
                  />
                  <label className="mt-1 flex items-center gap-1 font-body text-[9px] text-neutral-700">
                    <input
                      type="checkbox"
                      checked={required.has(name)}
                      disabled={disabled}
                      onChange={(event) =>
                        onChange(
                          setVisualSchemaPropertyRequired(
                            schema,
                            name,
                            event.target.checked,
                          ),
                        )
                      }
                      className="h-3 w-3 accent-mariner"
                    />
                    Required
                  </label>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Remove ${name} property`}
                    onClick={() =>
                      onChange(removeVisualSchemaProperty(schema, name))
                    }
                    className="appearance-none border-none bg-transparent px-1 font-mono text-[10px] text-red-700 disabled:opacity-40"
                  >
                    Remove
                  </button>
                </div>
                <SchemaNodeEditor
                  schema={child}
                  disabled={disabled}
                  depth={depth + 1}
                  pathLabel={`${pathLabel}.${name}`}
                  onChange={(nextChild) =>
                    onChange(setVisualSchemaProperty(schema, name, nextChild))
                  }
                />
              </div>
            );
          })}
          <div className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1">
              <input
                aria-label={`${pathLabel} new property name`}
                value={newProperty}
                disabled={disabled}
                placeholder="new_field"
                onChange={(event) => {
                  setNewProperty(event.target.value);
                  setNewPropertyError(null);
                }}
                className={`${fieldClass} w-full`}
              />
              {newPropertyError && (
                <p className="m-0 mt-1 font-body text-[9px] text-red-700">
                  {newPropertyError}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={disabled || newProperty.length === 0}
              onClick={() => {
                const next = addVisualSchemaProperty(schema, newProperty);
                if (!next) {
                  setNewPropertyError(
                    "Use a unique name made from letters, numbers, _ or -.",
                  );
                  return;
                }
                onChange(next);
                setNewProperty("");
                setNewPropertyError(null);
              }}
              className="h-[26px] appearance-none rounded-xs border border-mariner bg-panel px-2 font-mono text-[9px] uppercase tracking-[0.04em] text-mariner disabled:opacity-40"
            >
              Add field
            </button>
          </div>
        </div>
      )}

      {type === "array" && (
        <div>
          <div className="font-mono text-[8px] uppercase tracking-[0.05em] text-neutral-500">
            Item schema
          </div>
          <SchemaNodeEditor
            schema={
              schema.items !== null &&
              typeof schema.items === "object" &&
              !Array.isArray(schema.items)
                ? (schema.items as JsonSchema202012)
                : { type: "string" }
            }
            disabled={disabled}
            depth={depth + 1}
            pathLabel={`${pathLabel} items`}
            onChange={(items) =>
              onChange(setVisualSchemaArrayItems(schema, items))
            }
          />
        </div>
      )}
    </div>
  );
}

export function JsonSchemaEditor({
  value,
  disabled,
  label,
  onChange,
  onDialectChange,
  onValidationStateChange,
}: {
  value: string;
  disabled: boolean;
  label: string;
  onChange: (source: string) => void;
  onDialectChange?: (dialect: typeof DIALECT) => void;
  onValidationStateChange?: (
    state: JsonSchemaEditorValidationState,
  ) => void;
}) {
  const [mode, setMode] = useState<"visual" | "raw">("visual");
  const [inspection, setInspection] = useState<{
    source: string;
    result: JsonSchemaAuthoringInspectionResponse;
  } | null>(null);
  const [visualSnapshot, setVisualSnapshot] = useState<{
    source: string;
    value: JsonSchema202012 | null;
  } | null>(null);
  const [transportFailure, setTransportFailure] = useState<{
    source: string;
    value: string;
  } | null>(null);
  const rawRef = useRef<HTMLTextAreaElement>(null);
  const validationCallbackRef = useRef(onValidationStateChange);
  validationCallbackRef.current = onValidationStateChange;

  useEffect(() => {
    const controller = new AbortController();
    validationCallbackRef.current?.("checking");
    const timer = window.setTimeout(() => {
      inspectSchemaSource(value, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setInspection({ source: value, result });
          setTransportFailure(null);
          setVisualSnapshot({
            source: value,
            value: result.deployable ? result.schema : null,
          });
          validationCallbackRef.current?.(
            result.deployable ? "valid" : "invalid",
          );
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setVisualSnapshot({ source: value, value: null });
          setTransportFailure({
            source: value,
            value:
              error instanceof Error
                ? error.message
                : "Schema inspection failed",
          });
          validationCallbackRef.current?.("invalid");
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  const currentInspection =
    inspection?.source === value ? inspection.result : null;
  const visualSchema = valueForExactSchemaSource(value, visualSnapshot);
  const transportError = valueForExactSchemaSource(value, transportFailure);
  const inspectPending = currentInspection === null && transportError === null;

  const applyVisualChange = (schema: JsonSchema202012) => {
    const source = JSON.stringify(schema, null, 2);
    setVisualSnapshot({ source, value: schema });
    validationCallbackRef.current?.("checking");
    onDialectChange?.(DIALECT);
    onChange(source);
  };

  const showRawIssue = (path: string) => {
    setMode("raw");
    window.requestAnimationFrame(() => {
      const textarea = rawRef.current;
      if (!textarea) return;
      textarea.focus();
      const segment = path
        .split("/")
        .at(-1)
        ?.replaceAll("~1", "/")
        .replaceAll("~0", "~");
      if (!segment) return;
      const index = value.indexOf(`"${segment}"`);
      if (index >= 0) textarea.setSelectionRange(index, index + segment.length + 2);
    });
  };

  return (
    <div
      role="group"
      aria-label={label}
      className="overflow-hidden rounded-xs border border-neutral-200 bg-panel"
    >
      <div className="flex items-center gap-1 border-b border-neutral-200 bg-app-bg px-2 py-1.5">
        {(["visual", "raw"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => setMode(candidate)}
            aria-pressed={mode === candidate}
            className={`appearance-none rounded-xs border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.05em] ${
              mode === candidate
                ? "border-mariner bg-panel text-mariner"
                : "border-transparent bg-transparent text-neutral-500"
            }`}
          >
            {candidate}
          </button>
        ))}
        <span className="ml-auto font-mono text-[8px] text-neutral-500">
          JSON Schema 2020-12
        </span>
      </div>

      {mode === "raw" ? (
        <div className="p-2">
          <textarea
            ref={rawRef}
            aria-label={label}
            value={value}
            disabled={disabled}
            spellCheck={false}
            rows={10}
            onChange={(event) => {
              setVisualSnapshot({ source: event.target.value, value: null });
              validationCallbackRef.current?.("checking");
              onDialectChange?.(DIALECT);
              onChange(event.target.value);
            }}
            className={`${fieldClass} min-h-[180px] w-full resize-y leading-[1.45]`}
          />
        </div>
      ) : (
        <div className="p-2">
          {visualSchema ? (
            <SchemaNodeEditor
              key={label}
              schema={visualSchema}
              disabled={disabled}
              depth={0}
              pathLabel="Output"
              onChange={applyVisualChange}
            />
          ) : inspectPending ? (
            <p className="m-0 py-3 text-center font-body text-[11px] text-neutral-500">
              Checking schema…
            </p>
          ) : value.trim().length === 0 ? (
            <div className="py-3 text-center">
              <p className="m-0 mb-2 font-body text-[11px] text-neutral-600">
                Create a schema visually, or paste one in Raw.
              </p>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  applyVisualChange(structuredClone(DEFAULT_VISUAL_JSON_SCHEMA))
                }
                className="appearance-none rounded-xs border border-mariner bg-panel px-2 py-1 font-mono text-[9px] uppercase tracking-[0.05em] text-mariner disabled:opacity-40"
              >
                Create schema
              </button>
            </div>
          ) : (
            <p className="m-0 py-3 text-center font-body text-[11px] text-neutral-600">
              This source cannot be safely edited visually. Fix it in Raw using
              the exact paths below.
            </p>
          )}
        </div>
      )}

      {transportError && (
        <div className="border-t border-red-200 bg-red-50 px-2 py-1.5 font-body text-[10px] text-red-800">
          {transportError}
        </div>
      )}
      {currentInspection && !currentInspection.deployable && (
        <div className="border-t border-red-200 bg-red-50 px-2 py-1.5">
          <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.05em] text-red-800">
            Schema errors
          </div>
          <ul className="m-0 space-y-1 p-0">
            {currentInspection.issues.map((issue, index) => (
              <li
                key={`${issue.path}:${issue.code}:${index}`}
                className="list-none font-body text-[10px] leading-[1.35] text-red-800"
              >
                <button
                  type="button"
                  onClick={() => showRawIssue(issue.path)}
                  className="appearance-none border-none bg-transparent p-0 text-left text-inherit"
                >
                  <span className="font-mono">
                    {issue.path === "" ? "/" : issue.path}
                  </span>
                  {": "}
                  {issue.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
