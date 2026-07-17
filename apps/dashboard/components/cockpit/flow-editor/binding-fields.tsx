"use client";

import { useMemo, useState } from "react";
import type {
  WorkflowBlockContract,
  WorkflowDefinition,
  WorkflowEditorOptions,
  WorkflowInputBindings,
} from "@shared/contracts";
import {
  buildBindingEditorRows,
  canAddAdditionalInput,
  removeLegacyRequiredCheck,
} from "@/lib/workflow-editor/binding-options";

const inputClass =
  "h-[28px] min-w-0 px-2 bg-off-white border border-neutral-200 rounded-xs font-mono text-[11px] text-coal outline-none disabled:opacity-60";

export function BindingFields({
  definition,
  nodeId,
  options,
  nodeContracts,
  canEdit,
  onChange,
  onLegacyParamsChange,
}: {
  definition: WorkflowDefinition;
  nodeId: string;
  options: WorkflowEditorOptions;
  nodeContracts: Record<string, WorkflowBlockContract>;
  canEdit: boolean;
  onChange: (name: string, value: string | undefined) => void;
  onLegacyParamsChange: (params: WorkflowDefinition["nodes"][number]["params"]) => void;
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
  const legacyRequiredChecks =
    node?.type === "finalize_workspace" && Array.isArray(node.params.legacyRequiredChecks)
      ? node.params.legacyRequiredChecks
      : [];
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
      {legacyRequiredChecks.length > 0 && (
        <div className="border-b border-amber-300 bg-amber-50">
          <div className="py-2 px-[14px] border-b border-amber-200 font-mono text-[9px] font-semibold tracking-[0.05em] uppercase text-amber-900">
            Legacy required checks
          </div>
          {legacyRequiredChecks.map((sourceId) => {
            const replacement = node.inputs[`checks.${sourceId}`];
            const replacementBound =
              typeof replacement === "string" && replacement.trim() !== "";
            return (
              <div
                key={sourceId}
                className="flex items-center gap-2 py-2.5 px-[14px] border-b border-amber-200 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] text-amber-950 break-all">{sourceId}</div>
                  <div className="mt-0.5 font-body text-[10px] leading-[1.35] text-amber-800">
                    {replacementBound
                      ? "Replacement binding is set; Save Draft completes this migration."
                      : "Add a checks.* replacement, or explicitly remove this legacy requirement."}
                  </div>
                </div>
                {!replacementBound && canEdit && (
                  <button
                    type="button"
                    onClick={() =>
                      onLegacyParamsChange(removeLegacyRequiredCheck(node.params, sourceId))
                    }
                    className="appearance-none cursor-pointer border border-amber-400 bg-panel px-2 py-1 rounded-xs font-mono text-[9px] uppercase tracking-[0.04em] text-amber-900"
                  >
                    Remove requirement
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
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
