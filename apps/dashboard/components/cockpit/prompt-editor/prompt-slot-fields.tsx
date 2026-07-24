"use client";

import { useEffect, useRef, useState } from "react";
import {
  isPromptSlotBinding,
  PROMPT_SLOT_NAME_PATTERN,
  type JsonSchema202012,
  type JsonValue,
  type PromptSlotBinding,
  type PromptSlotDefinition,
  type WorkflowDataCatalogEntry,
  type WorkflowDataReferenceV2,
} from "@shared/contracts";
import { JsonSchemaEditor } from "@/components/cockpit/flow-editor/json-schema-editor";
import type { JsonSchemaEditorValidationState } from "@/components/cockpit/flow-editor/json-schema-editor";

const inputClass =
  "min-w-0 rounded-xs border border-neutral-200 bg-off-white px-2 py-1 font-mono text-[10px] text-coal outline-none focus:border-mariner disabled:opacity-60";
const quietButton =
  "appearance-none rounded-xs border border-neutral-200 bg-panel px-2 py-1 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-600 hover:bg-off-white disabled:opacity-40";

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export interface PromptSlotSchemaDraftState {
  state: JsonSchemaEditorValidationState;
  hasUncommittedInvalidSource: boolean;
}

export function promptSlotSchemaDraftBlocksSave(
  state: PromptSlotSchemaDraftState,
): boolean {
  return state.state !== "valid";
}

export function promptSlotSchemaDraftMarksDirty(
  state: PromptSlotSchemaDraftState,
): boolean {
  return state.hasUncommittedInvalidSource;
}

export function aggregatePromptSlotSchemaDraftState(
  slotKeys: readonly string[],
  states: Readonly<Record<string, PromptSlotSchemaDraftState>>,
): PromptSlotSchemaDraftState {
  if (slotKeys.length === 0) {
    return { state: "valid", hasUncommittedInvalidSource: false };
  }
  const values = slotKeys.map((key) => states[key]);
  return {
    state: values.some((value) => value?.state === "invalid")
      ? "invalid"
      : values.every((value) => value?.state === "valid")
        ? "valid"
        : "checking",
    hasUncommittedInvalidSource: values.some(
      (value) => value?.hasUncommittedInvalidSource === true,
    ),
  };
}

function PromptSlotSchemaEditor({
  value,
  disabled,
  label,
  onChange,
  onDraftStateChange,
}: {
  value: JsonSchema202012;
  disabled: boolean;
  label: string;
  onChange: (value: JsonSchema202012) => void;
  onDraftStateChange: (state: PromptSlotSchemaDraftState) => void;
}) {
  const serialized = stableJson(value);
  const [source, setSource] = useState(serialized);
  const [lastCommitted, setLastCommitted] = useState(serialized);
  const hasUncommittedInvalidSource = useRef(false);
  useEffect(() => {
    if (serialized === lastCommitted) return;
    setSource(serialized);
    setLastCommitted(serialized);
    hasUncommittedInvalidSource.current = false;
    onDraftStateChange({
      state: "checking",
      hasUncommittedInvalidSource: false,
    });
  }, [lastCommitted, onDraftStateChange, serialized]);
  const update = (nextSource: string) => {
    setSource(nextSource);
    try {
      const parsed = JSON.parse(nextSource) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("schema");
      }
      hasUncommittedInvalidSource.current = false;
      setLastCommitted(stableJson(parsed));
      onChange(parsed as JsonSchema202012);
      onDraftStateChange({
        state: "checking",
        hasUncommittedInvalidSource: false,
      });
    } catch {
      hasUncommittedInvalidSource.current = true;
      onDraftStateChange({
        state: "invalid",
        hasUncommittedInvalidSource: true,
      });
    }
  };
  return (
    <JsonSchemaEditor
      value={source}
      disabled={disabled}
      label={label}
      onChange={update}
      onValidationStateChange={(state) =>
        onDraftStateChange({
          state:
            hasUncommittedInvalidSource.current && state === "checking"
              ? "invalid"
              : state,
          hasUncommittedInvalidSource:
            hasUncommittedInvalidSource.current,
        })
      }
    />
  );
}

function JsonValueField({
  value,
  disabled,
  label,
  onChange,
}: {
  value: JsonValue;
  disabled: boolean;
  label: string;
  onChange: (value: JsonValue) => void;
}) {
  const serialized = stableJson(value);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(serialized);
    setError(null);
  }, [serialized]);
  const commit = () => {
    try {
      setError(null);
      onChange(JSON.parse(draft) as JsonValue);
    } catch {
      setError("Enter a valid JSON value.");
    }
  };
  return (
    <>
      <textarea
        aria-label={label}
        value={draft}
        disabled={disabled}
        rows={2}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        className={`${inputClass} w-full resize-y leading-[1.45]`}
      />
      {error && (
        <p className="m-0 mt-1 font-body text-[10px] text-red-700">{error}</p>
      )}
    </>
  );
}

function primarySchemaType(schema: JsonSchema202012): string {
  const raw = schema.type;
  const candidate =
    (Array.isArray(raw)
      ? raw.find((candidate) => candidate !== "null")
      : raw) ?? "string";
  return typeof candidate === "string" ? candidate : "string";
}

function schemaNullable(schema: JsonSchema202012): boolean {
  return Array.isArray(schema.type) && schema.type.includes("null");
}

function schemaForType(
  type: string,
  nullable: boolean,
): JsonSchema202012 {
  const schema: JsonSchema202012 = {
    type: nullable && type !== "null" ? [type, "null"] : type,
  };
  if (type === "object") {
    schema.properties = {};
    schema.required = [];
    schema.additionalProperties = false;
  } else if (type === "array") {
    schema.items = { type: "string" };
  }
  return schema;
}

function initialLiteral(definition: PromptSlotDefinition): JsonValue {
  if (Object.hasOwn(definition, "defaultValue")) {
    return structuredClone(definition.defaultValue as JsonValue);
  }
  switch (primarySchemaType(definition.schema)) {
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
}

function nextSlotName(slots: readonly PromptSlotDefinition[]): string {
  const names = new Set(slots.map((slot) => slot.name));
  let suffix = 1;
  while (names.has(`slot_${suffix}`)) suffix += 1;
  return `slot_${suffix}`;
}

function SlotNameField({
  value,
  otherNames,
  disabled,
  onRename,
}: {
  value: string;
  otherNames: ReadonlySet<string>;
  disabled: boolean;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);
  const commit = () => {
    if (draft === value) return;
    if (!PROMPT_SLOT_NAME_PATTERN.test(draft) || otherNames.has(draft)) {
      setError("Use a unique name made from letters, numbers, _ or -.");
      return;
    }
    setError(null);
    onRename(draft);
  };
  return (
    <div className="min-w-0 flex-1">
      <input
        aria-label={`Slot name ${value}`}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        className={`${inputClass} w-full`}
      />
      {error && (
        <p className="m-0 mt-1 font-body text-[9px] text-red-700">{error}</p>
      )}
    </div>
  );
}

export function PromptSlotDefinitionsEditor({
  slots,
  disabled,
  onChange,
  onRename,
  onSchemaDraftStateChange,
}: {
  slots: readonly PromptSlotDefinition[];
  disabled: boolean;
  onChange: (slots: PromptSlotDefinition[]) => void;
  onRename?: (currentName: string, nextName: string) => void;
  onSchemaDraftStateChange?: (state: PromptSlotSchemaDraftState) => void;
}) {
  const [schemaDraftStates, setSchemaDraftStates] = useState<
    Record<string, PromptSlotSchemaDraftState>
  >({});
  const schemaStateCallbackRef = useRef(onSchemaDraftStateChange);
  schemaStateCallbackRef.current = onSchemaDraftStateChange;
  const slotKeys = slots.map((slot, index) => `${index}:${slot.name}`);
  const slotKeySignature = slotKeys.join("\u0000");
  const aggregate = aggregatePromptSlotSchemaDraftState(
    slotKeys,
    schemaDraftStates,
  );
  useEffect(() => {
    setSchemaDraftStates((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([key]) => slotKeys.includes(key)),
      );
      return Object.keys(next).length === Object.keys(current).length
        ? current
        : next;
    });
    // `slotKeySignature` is the stable semantic dependency for this array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKeySignature]);
  useEffect(() => {
    schemaStateCallbackRef.current?.(aggregate);
  }, [
    aggregate.hasUncommittedInvalidSource,
    aggregate.state,
  ]);

  const update = (
    index: number,
    change: (slot: PromptSlotDefinition) => PromptSlotDefinition,
  ) => {
    onChange(
      slots.map((slot, candidate) =>
        candidate === index ? change(slot) : slot,
      ),
    );
  };

  return (
    <section className="rounded-xs border border-neutral-200 bg-panel">
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-off-white/70 px-3 py-2">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
            Prompt slots
          </div>
          <p className="m-0 mt-0.5 font-body text-[10px] text-neutral-500">
            Values a workflow must provide when it uses this prompt.
          </p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            onChange([
              ...slots,
              {
                name: nextSlotName(slots),
                description: "",
                schema: { type: "string" },
                required: true,
              },
            ])
          }
          className={`${quietButton} ml-auto text-mariner`}
        >
          + Add slot
        </button>
      </div>
      {slots.length === 0 ? (
        <div className="px-3 py-3 font-body text-[11px] text-neutral-500">
          This prompt does not require values from its caller.
        </div>
      ) : (
        <div className="divide-y divide-neutral-200">
          {slots.map((slot, index) => {
            const type = primarySchemaType(slot.schema);
            const nullable = schemaNullable(slot.schema);
            const otherNames = new Set(
              slots
                .filter((_, candidate) => candidate !== index)
                .map((candidate) => candidate.name),
            );
            return (
              <div key={`${slot.name}:${index}`} className="space-y-2 px-3 py-3">
                <div className="flex items-start gap-2">
                  <SlotNameField
                    value={slot.name}
                    otherNames={otherNames}
                    disabled={disabled}
                    onRename={(name) => {
                      update(index, (current) => ({ ...current, name }));
                      onRename?.(slot.name, name);
                    }}
                  />
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      onChange(
                        slots.filter((_, candidate) => candidate !== index),
                      )
                    }
                    className={`${quietButton} text-red-700`}
                  >
                    Remove
                  </button>
                </div>
                <input
                  aria-label={`${slot.name} description`}
                  value={slot.description}
                  disabled={disabled}
                  placeholder="What value should the workflow provide?"
                  onChange={(event) =>
                    update(index, (current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  className={`${inputClass} w-full font-body`}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <select
                    aria-label={`${slot.name} type`}
                    value={type}
                    disabled={disabled}
                    onChange={(event) =>
                      update(index, (current) => ({
                        ...current,
                        schema: schemaForType(
                          event.target.value,
                          schemaNullable(current.schema),
                        ),
                      }))
                    }
                    className={`${inputClass} min-w-[120px]`}
                  >
                    {["string", "number", "boolean", "object", "array", "null"].map(
                      (candidate) => (
                        <option key={candidate} value={candidate}>
                          {candidate}
                        </option>
                      ),
                    )}
                  </select>
                  <label className="flex items-center gap-1.5 font-body text-[10px] text-neutral-700">
                    <input
                      type="checkbox"
                      checked={nullable}
                      disabled={disabled || type === "null"}
                      onChange={(event) =>
                        update(index, (current) => ({
                          ...current,
                          schema: schemaForType(
                            primarySchemaType(current.schema),
                            event.target.checked,
                          ),
                        }))
                      }
                      className="h-3 w-3 accent-mariner"
                    />
                    Allow null
                  </label>
                  <label className="flex items-center gap-1.5 font-body text-[10px] text-neutral-700">
                    <input
                      type="checkbox"
                      checked={slot.required}
                      disabled={disabled}
                      onChange={(event) =>
                        update(index, (current) => ({
                          ...current,
                          required: event.target.checked,
                        }))
                      }
                      className="h-3 w-3 accent-mariner"
                    />
                    Required
                  </label>
                  <label className="flex items-center gap-1.5 font-body text-[10px] text-neutral-700">
                    <input
                      type="checkbox"
                      checked={Object.hasOwn(slot, "defaultValue")}
                      disabled={disabled}
                      onChange={(event) =>
                        update(index, (current) => {
                          if (event.target.checked) {
                            return {
                              ...current,
                              defaultValue: initialLiteral(current),
                            };
                          }
                          const next = { ...current };
                          delete next.defaultValue;
                          return next;
                        })
                      }
                      className="h-3 w-3 accent-mariner"
                    />
                    Has default
                  </label>
                </div>
                {Object.hasOwn(slot, "defaultValue") && (
                  <JsonValueField
                    label={`${slot.name} default JSON`}
                    value={slot.defaultValue as JsonValue}
                    disabled={disabled}
                    onChange={(defaultValue) =>
                      update(index, (current) => ({
                        ...current,
                        defaultValue,
                      }))
                    }
                  />
                )}
                <details>
                  <summary className="cursor-pointer font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-500">
                    Advanced schema
                  </summary>
                  <div className="mt-1.5">
                    <PromptSlotSchemaEditor
                      label={`${slot.name} JSON Schema`}
                      value={slot.schema}
                      disabled={disabled}
                      onDraftStateChange={(state) =>
                        setSchemaDraftStates((current) =>
                          current[slotKeys[index]]?.state === state.state &&
                          current[slotKeys[index]]
                            ?.hasUncommittedInvalidSource ===
                            state.hasUncommittedInvalidSource
                            ? current
                            : { ...current, [slotKeys[index]]: state },
                        )
                      }
                      onChange={(schema) =>
                        update(index, (current) => ({ ...current, schema }))
                      }
                    />
                  </div>
                </details>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function promptSlotBindingsFromConfiguration(
  configuration: Readonly<Record<string, JsonValue>>,
): Record<string, PromptSlotBinding> {
  const candidate = configuration.promptSlotBindings;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(candidate).filter((entry): entry is [string, PromptSlotBinding] =>
      isPromptSlotBinding(entry[1]),
    ),
  );
}

export function PromptSlotBindingsEditor({
  definitions,
  bindings,
  availableValues,
  disabled,
  onChange,
}: {
  definitions: readonly PromptSlotDefinition[];
  bindings: Readonly<Record<string, PromptSlotBinding>>;
  availableValues: readonly WorkflowDataCatalogEntry[];
  disabled: boolean;
  onChange: (bindings: Record<string, PromptSlotBinding>) => void;
}) {
  if (definitions.length === 0) return null;
  const update = (name: string, binding: PromptSlotBinding | undefined) => {
    const next = { ...bindings };
    if (binding === undefined) delete next[name];
    else next[name] = binding;
    onChange(next);
  };

  return (
    <section className="mt-2 overflow-hidden rounded-xs border border-neutral-200">
      <div className="border-b border-neutral-200 bg-app-bg px-2.5 py-2">
        <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
          Prompt slot values
        </div>
        <p className="m-0 mt-1 font-body text-[10px] leading-[1.4] text-neutral-500">
          Choose a guaranteed workflow value or enter a literal. Workflow
          validation checks the selected value against the slot schema.
        </p>
      </div>
      {definitions.map((definition) => {
        const selectableValues = availableValues.filter(
          (value) => value.availability.state === "available",
        );
        const binding = bindings[definition.name];
        const currentReference =
          binding?.kind === "reference"
            ? selectableValues.find(
                (value) => value.reference === binding.reference,
              )
            : undefined;
        return (
          <div
            key={definition.name}
            className="space-y-1.5 border-b border-neutral-200 px-2.5 py-2.5 last:border-b-0"
          >
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] text-neutral-800">
                {definition.name}
              </span>
              {definition.required && (
                <span className="font-mono text-[8px] uppercase tracking-[0.05em] text-red-700">
                  Required
                </span>
              )}
              {Object.hasOwn(definition, "defaultValue") && (
                <span className="font-mono text-[8px] uppercase tracking-[0.05em] text-neutral-500">
                  Default available
                </span>
              )}
            </div>
            {definition.description && (
              <p className="m-0 font-body text-[10px] text-neutral-500">
                {definition.description}
              </p>
            )}
            <select
              aria-label={`${definition.name} slot binding type`}
              value={binding?.kind ?? ""}
              disabled={disabled}
              onChange={(event) => {
                if (event.target.value === "") {
                  update(definition.name, undefined);
                } else if (event.target.value === "reference") {
                  const first = selectableValues[0];
                  update(
                    definition.name,
                    first
                      ? {
                          kind: "reference",
                          reference: first.reference,
                        }
                      : undefined,
                  );
                } else {
                  update(definition.name, {
                    kind: "literal",
                    value: initialLiteral(definition),
                  });
                }
              }}
              className={`${inputClass} w-full`}
            >
              <option value="">
                {Object.hasOwn(definition, "defaultValue")
                  ? "Use prompt default"
                  : definition.required
                    ? "Choose a value…"
                    : "Leave unfilled"}
              </option>
              <option value="reference" disabled={selectableValues.length === 0}>
                Workflow value
              </option>
              <option value="literal">Literal value</option>
            </select>
            {binding?.kind === "reference" && (
              <select
                aria-label={`${definition.name} workflow value`}
                value={binding.reference}
                disabled={disabled}
                onChange={(event) =>
                  update(definition.name, {
                    kind: "reference",
                    reference: event.target
                      .value as WorkflowDataReferenceV2,
                  })
                }
                className={`${inputClass} w-full`}
              >
                {!currentReference && (
                  <option value={binding.reference}>
                    Unavailable: {binding.reference}
                  </option>
                )}
                {selectableValues.map((value) => (
                  <option key={value.reference} value={value.reference}>
                    {value.label}
                  </option>
                ))}
              </select>
            )}
            {binding?.kind === "literal" && (
              <JsonValueField
                label={`${definition.name} literal JSON`}
                value={binding.value}
                disabled={disabled}
                onChange={(value) =>
                  update(definition.name, { kind: "literal", value })
                }
              />
            )}
          </div>
        );
      })}
    </section>
  );
}
