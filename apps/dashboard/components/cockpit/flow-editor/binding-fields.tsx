"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  isSafeWorkflowInputName,
  type JsonSchema202012,
  type JsonValue,
  type WorkflowAdditionalInputV2,
  type WorkflowDataCatalogEntry,
  type WorkflowBlockContract,
  type WorkflowDataReferenceV2,
  type WorkflowDefinitionV1,
  type WorkflowDefinitionV2Node,
  type WorkflowEditorOptions,
  type WorkflowInputBindingV2,
  type WorkflowInputBindings,
  type WorkflowValueSchema,
} from "@shared/contracts";
import {
  buildBindingEditorRows,
  canAddAdditionalInput,
} from "@/lib/workflow-editor/binding-options";
import { JsonSchemaEditor } from "./json-schema-editor";
import {
  inputCompatibility,
  WorkflowDataPicker,
  WorkflowValueChip,
} from "./workflow-data-picker";

const inputClass =
  "h-[28px] min-w-0 px-2 bg-off-white border border-neutral-200 rounded-xs font-mono text-[11px] text-coal outline-none disabled:opacity-60";

export function BindingFields({
  definition,
  nodeId,
  options,
  nodeContracts,
  canEdit,
  onChange,
}: {
  definition: WorkflowDefinitionV1;
  nodeId: string;
  options: WorkflowEditorOptions;
  nodeContracts: Record<string, WorkflowBlockContract>;
  canEdit: boolean;
  onChange: (name: string, value: string | undefined) => void;
}) {
  const [newInputName, setNewInputName] = useState("");
  const rows = useMemo(
    () => buildBindingEditorRows({ definition, consumerId: nodeId, options, nodeContracts }),
    [definition, nodeContracts, nodeId, options],
  );
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  const contract = node
    ? nodeContracts[node.id] ?? options.blockRegistry[node.type]
    : null;
  if (!node || !contract || (rows.length === 0 && contract.additionalInputs.length === 0)) {
    return null;
  }

  const addState = canAddAdditionalInput(newInputName, rows, contract);
  return (
    <section className="border-t border-neutral-200">
      <div className="py-2 px-[14px] border-b border-neutral-200 bg-app-bg">
        <div className="font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase">
          Input bindings
        </div>
        <p className="m-0 mt-1 font-body text-[11px] leading-[1.4] text-neutral-600">
          Bind exact values from the trigger, guaranteed earlier steps, or this run.
        </p>
      </div>
      {rows.map((row) => {
        const listId = `binding-${nodeId}-${row.name.replace(/[^A-Za-z0-9_-]/g, "-")}`;
        return (
          <div key={row.name} className="py-2.5 px-[14px] border-b border-neutral-200">
            <div className="mb-1 flex items-center gap-1.5">
              <label
                htmlFor={listId}
                className="font-mono text-[9px] text-neutral-700 tracking-[0.04em]"
              >
                {row.name}
              </label>
              {row.required && (
                <span className="font-mono text-[8px] uppercase tracking-[0.05em] text-red-700">
                  Required
                </span>
              )}
              {row.legacy && (
                <span className="font-mono text-[8px] uppercase tracking-[0.05em] text-amber-700">
                  Unsupported input
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <input
                id={listId}
                list={`${listId}-options`}
                value={row.value}
                disabled={!canEdit}
                placeholder="trigger.ticketKey"
                onChange={(event) => onChange(row.name, event.target.value)}
                className={`${inputClass} flex-1`}
              />
              {(row.variadic || !row.required) && canEdit && (
                <button
                  type="button"
                  onClick={() => onChange(row.name, undefined)}
                  aria-label={`Remove ${row.name} input`}
                  className="appearance-none cursor-pointer border border-neutral-200 bg-panel h-[28px] px-2 rounded-xs font-mono text-[11px] text-[#A2351C]"
                >
                  ×
                </button>
              )}
            </div>
            <datalist id={`${listId}-options`}>
              {row.suggestions.map((source) => (
                <option key={source} value={source} />
              ))}
            </datalist>
            {row.legacy && (
              <p className="m-0 mt-1 font-body text-[10px] leading-[1.35] text-amber-800">
                This saved input is no longer in the block contract. Remove it, or move its
                value to a supported input.
              </p>
            )}
          </div>
        );
      })}
      {contract.additionalInputs.length > 0 && canEdit && (
        <div className="py-2.5 px-[14px] border-b border-neutral-200">
          <div className="font-mono text-[9px] text-neutral-700 tracking-[0.04em] mb-1">
            Add named input
          </div>
          <div className="flex items-center gap-1.5">
            <input
              value={newInputName}
              placeholder="context.ticket"
              onChange={(event) => setNewInputName(event.target.value)}
              className={`${inputClass} flex-1`}
            />
            <button
              type="button"
              disabled={!addState.allowed}
              onClick={() => {
                onChange(newInputName, "");
                setNewInputName("");
              }}
              className="appearance-none cursor-pointer border border-mariner bg-panel h-[28px] px-2 rounded-xs font-mono text-[10px] uppercase tracking-[0.04em] text-mariner disabled:opacity-40 disabled:cursor-default"
            >
              Add
            </button>
          </div>
          {newInputName !== "" && !addState.allowed && (
            <p className="m-0 mt-1 font-body text-[10px] leading-[1.35] text-red-700">
              {addState.reason}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

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

const jsonFieldClass =
  "min-h-[64px] w-full resize-y rounded-xs border border-neutral-200 bg-off-white px-2 py-1.5 font-mono text-[10px] leading-[1.4] text-coal outline-none focus:border-mariner disabled:opacity-60";

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
      <textarea
        aria-label={label}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        className={jsonFieldClass}
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
  canEdit,
  onChange,
}: {
  inputName: string;
  binding: WorkflowInputBindingV2 | undefined;
  inputSchema: WorkflowValueSchema | JsonSchema202012;
  availableValues: WorkflowDataCatalogEntry[];
  valuesRefreshing: boolean;
  required: boolean;
  canEdit: boolean;
  onChange: (binding: WorkflowInputBindingV2 | undefined) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const compatibility = useMemo(
    () => inputCompatibility(inputName),
    [inputName],
  );
  const currentReference =
    binding?.kind === "reference"
      ? availableValues.find((value) => value.reference === binding.reference)
      : undefined;
  const literalDefault = initialLiteralForSchema(inputSchema);

  return (
    <div className="space-y-1.5">
      <select
        aria-label={`${inputName} binding type`}
        value={binding?.kind ?? ""}
        disabled={!canEdit}
        onChange={(event) => {
          if (event.target.value === "") onChange(undefined);
          else if (event.target.value === "reference") {
            setPickerOpen(true);
          } else {
            onChange({ kind: "literal", value: literalDefault });
          }
        }}
        className={`${inputClass} w-full`}
      >
        <option value="">{required ? "Choose a value…" : "Not bound"}</option>
        <option value="reference">
          Workflow value
        </option>
        <option value="literal">Literal value</option>
      </select>
      {binding?.kind === "reference" && (
        <WorkflowValueChip
          value={currentReference ?? null}
          reference={binding.reference}
          disabled={!canEdit}
          onOpen={() => setPickerOpen(true)}
          onClear={() => onChange(undefined)}
        />
      )}
      <WorkflowDataPicker
        open={pickerOpen}
        entries={availableValues}
        selectedReference={
          binding?.kind === "reference" ? binding.reference : undefined
        }
        compatibility={compatibility}
        refreshing={valuesRefreshing}
        onClose={() => setPickerOpen(false)}
        onSelect={(entry) => {
          onChange({ kind: "reference", reference: entry.reference });
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
      {fixedInputs.map(([name, input]) => (
        <div key={name} className="border-b border-neutral-200 px-[14px] py-2.5">
          <div className="mb-1 flex items-center gap-1.5">
            <span className="font-mono text-[9px] tracking-[0.04em] text-neutral-700">
              {name}
            </span>
            {input.required && (
              <span className="font-mono text-[8px] uppercase tracking-[0.05em] text-red-700">
                Required
              </span>
            )}
          </div>
          <V2BindingEditor
            inputName={name}
            binding={node.inputs[name]}
            inputSchema={input.schema}
            availableValues={availableValues}
            valuesRefreshing={valuesRefreshing}
            required={input.required}
            canEdit={canEdit}
            onChange={(binding) => {
              const inputs = { ...node.inputs };
              if (binding) inputs[name] = binding;
              else delete inputs[name];
              onChange(inputs, node.additionalInputs);
            }}
          />
        </div>
      ))}
      {node.additionalInputs.map((input, index) => (
        <div key={`${input.name}-${index}`} className="border-b border-neutral-200 px-[14px] py-2.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-mono text-[9px] tracking-[0.04em] text-neutral-700">
              {input.name}
            </span>
            {canEdit && (
              <button
                type="button"
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
              </button>
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
            <input
              aria-label="Additional input name"
              value={newInputName}
              placeholder="context"
              onChange={(event) => setNewInputName(event.target.value)}
              className={`${inputClass} flex-1`}
            />
            <button
              type="button"
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
            </button>
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
