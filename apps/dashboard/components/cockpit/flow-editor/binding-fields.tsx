"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  describeSubjectDefault,
  isSafeWorkflowInputName,
  type JsonSchema202012,
  type JsonValue,
  type WorkflowAdditionalInputV2,
  type WorkflowDataCatalogEntry,
  type WorkflowBlockContract,
  type WorkflowDefinitionV2Node,
  type WorkflowInputBindingV2,
  type WorkflowInputBindings,
  type WorkflowValueSchema,
} from "@shared/contracts";
import { Button, IconButton, Input, Select, Textarea } from "@/components/ui";
import { JsonSchemaEditor } from "./json-schema-editor";
import {
  compatibilityInvalidReason,
  inputCompatibility,
  inputListItemCompatibility,
  WorkflowDataPicker,
  WorkflowValueChip,
} from "./workflow-data-picker";

export function updateInputBindings(
  inputs: WorkflowInputBindings,
  name: string,
  value: string | undefined,
): WorkflowInputBindings {
  const next = { ...inputs };
  if (value === undefined) delete next[name];
  else next[name] = value as WorkflowInputBindings[string];
  return next;
}

function initialLiteralForSchema(
  schema: WorkflowValueSchema | JsonSchema202012,
): JsonValue {
  if (schema.type === "nullable") {
    return initialLiteralForSchema((schema as Extract<
      WorkflowValueSchema,
      { type: "nullable" }
    >).value);
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  switch (type) {
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
    case "null":
    case "unknown":
      return null;
    default:
      return null;
  }
}

function isArrayInputSchema(
  schema: WorkflowValueSchema | JsonSchema202012,
): boolean {
  if (schema.type === "nullable") {
    return isArrayInputSchema(
      (schema as Extract<WorkflowValueSchema, { type: "nullable" }>).value,
    );
  }
  return Array.isArray(schema.type)
    ? schema.type.includes("array")
    : schema.type === "array";
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
  const serialized = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [lastValue, setLastValue] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  if (serialized !== lastValue) {
    setLastValue(serialized);
    setDraft(serialized);
    setError(null);
  }
  const commit = () => {
    try {
      const parsed = JSON.parse(draft) as JsonValue;
      setError(null);
      onChange(parsed);
    } catch {
      setError("Enter a valid JSON value.");
    }
  };
  return (
    <>
      <Textarea
        aria-label={label}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        size="sm"
        monospace
        className="min-h-[64px] w-full resize-y rounded-xs border border-neutral-200 bg-off-white px-2 py-1.5 font-mono text-[10px] leading-[1.4] text-coal outline-none focus:border-mariner disabled:opacity-60"
      />
      {error && <p className="m-0 mt-1 font-body text-[10px] text-red-700">{error}</p>}
    </>
  );
}

function JsonSchemaObjectField({
  value,
  disabled,
  label,
  onChange,
}: {
  value: JsonSchema202012;
  disabled: boolean;
  label: string;
  onChange: (value: JsonSchema202012) => void;
}) {
  const serialized = JSON.stringify(value, null, 2);
  const [source, setSource] = useState(serialized);
  const lastCommitted = useRef<string | null>(null);
  useEffect(() => {
    if (lastCommitted.current === serialized) {
      lastCommitted.current = null;
      return;
    }
    setSource(serialized);
  }, [serialized]);
  const update = (nextSource: string) => {
    setSource(nextSource);
    try {
      const parsed = JSON.parse(nextSource) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("schema");
      }
      lastCommitted.current = JSON.stringify(parsed, null, 2);
      onChange(parsed as JsonSchema202012);
    } catch {
      // Keep invalid source in the raw editor until the author finishes it.
    }
  };
  return (
    <JsonSchemaEditor
      label={label}
      value={source}
      disabled={disabled}
      onChange={update}
    />
  );
}

function V2BindingEditor({
  inputName,
  binding,
  inputSchema,
  availableValues,
  valuesRefreshing,
  required,
  unboundLabel,
  canEdit,
  onChange,
}: {
  inputName: string;
  binding: WorkflowInputBindingV2 | undefined;
  inputSchema: WorkflowValueSchema | JsonSchema202012;
  availableValues: WorkflowDataCatalogEntry[];
  valuesRefreshing: boolean;
  required: boolean;
  /** What the empty choice says; an input with a default names where it comes from. */
  unboundLabel?: string;
  canEdit: boolean;
  onChange: (binding: WorkflowInputBindingV2 | undefined) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<"reference" | "reference_list">(
    "reference",
  );
  const [listEditIndex, setListEditIndex] = useState<number | null>(null);
  const compatibility = useMemo(
    () => inputCompatibility(inputName),
    [inputName],
  );
  const listItemCompatibility = useMemo(
    () => inputListItemCompatibility(inputName),
    [inputName],
  );
  const currentReference =
    binding?.kind === "reference"
      ? availableValues.find((value) => value.reference === binding.reference)
      : undefined;
  const currentCompatibility = currentReference
    ? compatibility(currentReference)
    : null;
  const literalDefault = initialLiteralForSchema(inputSchema);
  const acceptsReferenceList = isArrayInputSchema(inputSchema);
  const openReferencePicker = () => {
    setPickerMode("reference");
    setListEditIndex(null);
    setPickerOpen(true);
  };
  const openListPicker = (index: number | null) => {
    setPickerMode("reference_list");
    setListEditIndex(index);
    setPickerOpen(true);
  };
  const moveListReference = (from: number, to: number) => {
    if (binding?.kind !== "reference_list") return;
    const references = [...binding.references];
    const [reference] = references.splice(from, 1);
    if (!reference) return;
    references.splice(to, 0, reference);
    onChange({ kind: "reference_list", references });
  };

  return (
    <div className="space-y-1.5">
      <Select
        aria-label={`${inputName} binding type`}
        value={binding?.kind ?? ""}
        disabled={!canEdit}
        size="compact"
        className="min-w-0 w-full"
        triggerClassName="h-[28px] min-w-0 w-full px-2 bg-off-white border border-neutral-200 rounded-xs font-mono text-[11px] text-coal outline-none disabled:opacity-60"
        options={[
          { value: "", label: unboundLabel ?? (required ? "Choose a value…" : "Not bound") },
          { value: "reference", label: "Workflow value" },
          ...((acceptsReferenceList || binding?.kind === "reference_list")
            ? [{ value: "reference_list", label: "Workflow value list" }]
            : []),
          { value: "literal", label: "Literal value" },
        ]}
        onChange={(value) => {
          if (value === "") {
            // Explicitly clear the binding; the callback's single argument is meaningful.
            // eslint-disable-next-line unicorn/no-useless-undefined -- Clear the binding value.
            onChange(undefined);
          }
          else if (value === "reference") {
            openReferencePicker();
          } else if (value === "reference_list") {
            onChange({ kind: "reference_list", references: [] });
            openListPicker(null);
          } else {
            onChange({ kind: "literal", value: literalDefault });
          }
        }}
      />
      {binding?.kind === "reference" && (
        <WorkflowValueChip
          value={currentReference ?? null}
          reference={binding.reference}
          invalidReason={compatibilityInvalidReason(currentCompatibility)}
          disabled={!canEdit}
          onOpen={openReferencePicker}
          onClear={() => {
            // Explicitly clear the binding; the callback's single argument is meaningful.
            // eslint-disable-next-line unicorn/no-useless-undefined -- Clear the binding value.
            onChange(undefined);
          }}
        />
      )}
      {binding?.kind === "reference_list" && (
        <div className="space-y-2">
          {binding.references.map((reference, index) => {
            const value = availableValues.find(
              (candidate) => candidate.reference === reference,
            );
            const itemCompatibility = value
              ? listItemCompatibility(value)
              : null;
            const moveLabel = value?.label ?? "saved workflow value";
            return (
              <div
                key={`${reference}-${index}`}
                className="flex items-start gap-1.5"
              >
                <div className="min-w-0 flex-1">
                  <WorkflowValueChip
                    value={value ?? null}
                    reference={reference}
                    invalidReason={compatibilityInvalidReason(itemCompatibility)}
                    disabled={!canEdit}
                    onOpen={() => openListPicker(index)}
                    onClear={() =>
                      onChange({
                        kind: "reference_list",
                        references: binding.references.filter(
                          (_, candidate) => candidate !== index,
                        ),
                      })
                    }
                  />
                </div>
                <div className="flex shrink-0 flex-col">
                  <IconButton
                    type="button"
                    size="sm"
                    disabled={!canEdit || index === 0}
                    onClick={() => moveListReference(index, index - 1)}
                    aria-label={`Move ${moveLabel} up`}
                    className="h-5 w-7 border border-neutral-200 bg-panel font-mono text-[10px] text-neutral-600 disabled:opacity-30"
                  >
                    ↑
                  </IconButton>
                  <IconButton
                    type="button"
                    size="sm"
                    disabled={
                      !canEdit || index === binding.references.length - 1
                    }
                    onClick={() => moveListReference(index, index + 1)}
                    aria-label={`Move ${moveLabel} down`}
                    className="h-5 w-7 border border-t-0 border-neutral-200 bg-panel font-mono text-[10px] text-neutral-600 disabled:opacity-30"
                  >
                    ↓
                  </IconButton>
                </div>
              </div>
            );
          })}
          <Button
            type="button"
            variant="secondary"
            size="md"
            disabled={!canEdit}
            onClick={() => openListPicker(null)}
            className="min-h-9 w-full justify-start rounded-[3px] border border-dashed border-neutral-300 bg-panel px-3 text-left font-body text-[12px] text-mariner disabled:opacity-50"
          >
            ＋ Add workflow value
          </Button>
        </div>
      )}
      <WorkflowDataPicker
        open={pickerOpen}
        entries={availableValues}
        selectedReference={
          pickerMode === "reference"
            ? binding?.kind === "reference"
              ? binding.reference
              : undefined
            : binding?.kind === "reference_list" &&
                listEditIndex !== null
              ? binding.references[listEditIndex]
              : undefined
        }
        compatibility={
          pickerMode === "reference" ? compatibility : listItemCompatibility
        }
        refreshing={valuesRefreshing}
        onClose={() => setPickerOpen(false)}
        onSelect={(entry) => {
          if (pickerMode === "reference") {
            onChange({ kind: "reference", reference: entry.reference });
          } else {
            const references =
              binding?.kind === "reference_list"
                ? [...binding.references]
                : [];
            if (listEditIndex === null) references.push(entry.reference);
            else references[listEditIndex] = entry.reference;
            onChange({ kind: "reference_list", references });
          }
          setPickerOpen(false);
        }}
      />
      {binding?.kind === "literal" && (
        <JsonValueField
          label={`${inputName} literal JSON`}
          value={binding.value}
          disabled={!canEdit}
          onChange={(value) => onChange({ kind: "literal", value })}
        />
      )}
    </div>
  );
}

export function canAddV2AdditionalInputName(
  name: string,
  existingNames: ReadonlySet<string>,
): boolean {
  return isSafeWorkflowInputName(name) && !existingNames.has(name);
}

export function V2BindingFields({
  node,
  contract,
  availableValues,
  valuesRefreshing = false,
  canEdit,
  onChange,
}: {
  node: WorkflowDefinitionV2Node;
  contract: WorkflowBlockContract;
  availableValues: WorkflowDataCatalogEntry[];
  valuesRefreshing?: boolean;
  canEdit: boolean;
  onChange: (
    inputs: WorkflowDefinitionV2Node["inputs"],
    additionalInputs: WorkflowAdditionalInputV2[],
  ) => void;
}) {
  const [newInputName, setNewInputName] = useState("");
  const [newInputSchema, setNewInputSchema] = useState<JsonSchema202012>({
    type: "string",
  });
  const fixedInputs = Object.entries(contract.inputs);
  if (fixedInputs.length === 0 && node.additionalInputs.length === 0 && !canEdit) {
    return null;
  }

  const updateAdditional = (
    index: number,
    update: (input: WorkflowAdditionalInputV2) => WorkflowAdditionalInputV2,
  ) => {
    onChange(
      node.inputs,
      node.additionalInputs.map((input, candidate) =>
        candidate === index ? update(input) : input,
      ),
    );
  };
  const existingNames = new Set([
    ...Object.keys(contract.inputs),
    ...node.additionalInputs.map((input) => input.name),
  ]);
  const canAdd = canAddV2AdditionalInputName(newInputName, existingNames);

  return (
    <section className="border-t border-neutral-200">
      <div className="border-b border-neutral-200 bg-app-bg px-[14px] py-2">
        <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
          Input values
        </div>
        <p className="m-0 mt-1 font-body text-[11px] leading-[1.4] text-neutral-600">
          Choose a guaranteed workflow value or enter a literal.
        </p>
      </div>
      {fixedInputs.map(([name, input]) => {
        const defaultFrom =
          input.defaultFromSubject && input.defaultFromSubject.length > 0
            ? describeSubjectDefault(input.defaultFromSubject)
            : null;
        return (
        <div key={name} className="border-b border-neutral-200 px-[14px] py-2.5">
          <div className="mb-1 flex items-center gap-1.5">
            <span className="font-mono text-[9px] tracking-[0.04em] text-neutral-700">
              {name}
            </span>
            {input.required && !defaultFrom && (
              <span className="font-mono text-[8px] uppercase tracking-[0.05em] text-red-700">
                Required
              </span>
            )}
          </div>
          {defaultFrom && !node.inputs[name] && (
            // Said before the author picks anything, because an unbound input
            // that still receives text is the case nobody would guess.
            <p className="m-0 mb-1 font-body text-[11px] leading-[1.4] text-neutral-600">
              Not bound, so it uses {defaultFrom}. Bind a value to use something else.
            </p>
          )}
          <V2BindingEditor
            inputName={name}
            binding={node.inputs[name]}
            inputSchema={input.schema}
            availableValues={availableValues}
            valuesRefreshing={valuesRefreshing}
            required={input.required}
            {...(defaultFrom ? { unboundLabel: `From ${defaultFrom}` } : {})}
            canEdit={canEdit}
            onChange={(binding) => {
              const inputs = { ...node.inputs };
              if (binding) inputs[name] = binding;
              else delete inputs[name];
              onChange(inputs, node.additionalInputs);
            }}
          />
        </div>
        );
      })}
      {node.additionalInputs.map((input, index) => (
        <div key={`${input.name}-${index}`} className="border-b border-neutral-200 px-[14px] py-2.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-mono text-[9px] tracking-[0.04em] text-neutral-700">
              {input.name}
            </span>
            {canEdit && (
              <Button
                type="button"
                variant="text"
                size="sm"
                onClick={() =>
                  onChange(
                    node.inputs,
                    node.additionalInputs.filter((_, candidate) => candidate !== index),
                  )
                }
                aria-label={`Remove ${input.name} input`}
                className="appearance-none border-none bg-transparent font-mono text-[9px] text-red-700"
              >
                Remove
              </Button>
            )}
          </div>
          <div className="mb-2">
            <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.05em] text-neutral-500">
              JSON Schema
            </div>
            <JsonSchemaObjectField
              label={`${input.name} JSON Schema`}
              value={input.schema}
              disabled={!canEdit}
              onChange={(schema) =>
                updateAdditional(index, (current) => ({ ...current, schema }))
              }
            />
          </div>
          <V2BindingEditor
            inputName={input.name}
            binding={input.binding}
            inputSchema={input.schema}
            availableValues={availableValues}
            valuesRefreshing={valuesRefreshing}
            required
            canEdit={canEdit}
            onChange={(binding) => {
              if (!binding) return;
              updateAdditional(index, (current) => ({ ...current, binding }));
            }}
          />
        </div>
      ))}
      {canEdit && (
        <div className="border-b border-neutral-200 px-[14px] py-2.5">
          <div className="mb-1 font-mono text-[9px] tracking-[0.04em] text-neutral-700">
            Add typed input
          </div>
          <div className="mb-2 flex items-center gap-1.5">
            <Input
              aria-label="Additional input name"
              value={newInputName}
              placeholder="context"
              onChange={(event) => setNewInputName(event.target.value)}
              size="sm"
              monospace
              className="h-[28px] min-w-0 flex-1 px-2 bg-off-white border border-neutral-200 rounded-xs font-mono text-[11px] text-coal outline-none disabled:opacity-60"
            />
            <Button
              type="button"
              size="sm"
              disabled={!canAdd}
              onClick={() => {
                onChange(node.inputs, [
                  ...node.additionalInputs,
                  {
                    name: newInputName,
                    schema: newInputSchema,
                    binding: {
                      kind: "literal",
                      value: initialLiteralForSchema(newInputSchema),
                    },
                  },
                ]);
                setNewInputName("");
                setNewInputSchema({ type: "string" });
              }}
              className="h-[28px] appearance-none rounded-xs border border-mariner bg-panel px-2 font-mono text-[10px] uppercase tracking-[0.04em] text-mariner disabled:opacity-40"
            >
              Add
            </Button>
          </div>
          <JsonSchemaObjectField
            label="New input JSON Schema"
            value={newInputSchema}
            disabled={false}
            onChange={setNewInputSchema}
          />
        </div>
      )}
    </section>
  );
}
