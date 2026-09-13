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
import { apiClient } from "@/lib/api/client";
import { Button, Checkbox, Input, Select, Textarea } from "@/components/ui";
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
  const response = await apiClient.jsonSchema.inspect(source, { signal });
  if (!response.ok) {
    throw new Error(`Schema inspection failed (${response.status})`);
  }
  return response.data;
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
      <Checkbox
        checked={value !== undefined}
        disabled={disabled}
        onChange={(event) =>
          onChange(event.target.checked ? defaultValue : null)
        }
        className="gap-1.5 text-[10px] text-neutral-700"
        label="Restrict to enum values"
      />
      {value !== undefined && (
        <>
          <Textarea
            aria-label="Enum values"
            value={draft}
            disabled={disabled}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            size="sm"
            monospace
            className="mt-1"
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
      <Input
        aria-label={`Property name ${value}`}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={keyDown}
        size="sm"
        monospace
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
        <Select
          aria-label={`${pathLabel} type`}
          value={type}
          disabled={disabled}
          size="compact"
          options={schemaTypes.map((candidate) => ({
            value: candidate,
            label: candidate,
          }))}
          onChange={(nextType) =>
            onChange(
              changeVisualSchemaType(
                schema,
                nextType as VisualJsonSchemaType,
              ),
            )
          }
          className="flex-1"
        />
        <Checkbox
          checked={nullable}
          disabled={disabled || type === "null"}
          onChange={(event) =>
            onChange(setVisualSchemaNullable(schema, event.target.checked))
          }
          className="gap-1 text-[10px] text-neutral-700"
          label="Nullable"
        />
      </div>
      <Input
        aria-label={`${pathLabel} description`}
        value={typeof schema.description === "string" ? schema.description : ""}
        disabled={disabled}
        placeholder="Description (optional)"
        onChange={(event) =>
          onChange(setVisualSchemaDescription(schema, event.target.value))
        }
        size="sm"
      />

      <EnumField
        value={enumValues}
        defaultValue={defaultEnumValues(type)}
        disabled={disabled}
        onChange={(values) => onChange(setVisualSchemaEnum(schema, values))}
      />

      {type === "object" && (
        <div className="space-y-2">
          <Checkbox
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
            className="gap-1.5 text-[10px] text-neutral-700"
            label="Allow fields not listed below"
          />
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
                  <Checkbox
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
                    className="mt-1 gap-1 text-[9px] text-neutral-700"
                    label="Required"
                  />
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={disabled}
                    aria-label={`Remove ${name} property`}
                    onClick={() =>
                      onChange(removeVisualSchemaProperty(schema, name))
                    }
                  >
                    Remove
                  </Button>
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
              <Input
                aria-label={`${pathLabel} new property name`}
                value={newProperty}
                disabled={disabled}
                placeholder="new_field"
                onChange={(event) => {
                  setNewProperty(event.target.value);
                  setNewPropertyError(null);
                }}
                size="sm"
                monospace
              />
              {newPropertyError && (
                <p className="m-0 mt-1 font-body text-[9px] text-red-700">
                  {newPropertyError}
                </p>
              )}
            </div>
            <Button
              type="button"
              size="sm"
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
            >
              Add field
            </Button>
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
          <Button
            key={candidate}
            type="button"
            variant={mode === candidate ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setMode(candidate)}
            aria-pressed={mode === candidate}
          >
            {candidate}
          </Button>
        ))}
        <span className="ml-auto font-mono text-[8px] text-neutral-500">
          JSON Schema 2020-12
        </span>
      </div>

      {mode === "raw" ? (
        <div className="p-2">
          <Textarea
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
            size="sm"
            monospace
            className="min-h-[180px]"
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
              <Button
                type="button"
                size="sm"
                disabled={disabled}
                onClick={() =>
                  applyVisualChange(structuredClone(DEFAULT_VISUAL_JSON_SCHEMA))
                }
              >
                Create schema
              </Button>
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
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => showRawIssue(issue.path)}
                  className="h-auto justify-start whitespace-normal text-left"
                >
                  <span className="font-mono">
                    {issue.path === "" ? "/" : issue.path}
                  </span>
                  {": "}
                  {issue.message}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
