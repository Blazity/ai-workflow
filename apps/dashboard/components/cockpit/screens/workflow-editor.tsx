"use client";

import React, { useState } from "react";
import type {
  RunBlockStatusesResponse,
  WorkflowDefinitionNode,
  WorkflowDefinitionResponse,
  WorkflowDefinitionSaveResponse,
  WorkflowDefinitionVersion,
} from "@shared/contracts";
import { FlowEditor } from "@/components/cockpit/screens/flow-editor";
import type { FlowEdgeDef, FlowNodeDef } from "@/lib/flows";
import { readErrorMessage } from "@/lib/api/error-message";
import { serializeWorkflowDefinition } from "@/lib/workflow-editor/serialize";
import { deriveRunStatuses } from "@/lib/workflow-editor/run-statuses";

function toViewNodes(nodes: WorkflowDefinitionNode[]): FlowNodeDef[] {
  return structuredClone(nodes).map((node) => ({
    ...node,
    locked: node.type === "trigger_ticket_ai",
  }));
}

function nodesValid(nodes: FlowNodeDef[]): boolean {
  if (nodes.filter((n) => n.type === "trigger_ticket_ai").length !== 1) return false;
  for (const node of nodes) {
    if (node.type === "update_ticket_status" && typeof node.params.target !== "string") return false;
    if (node.type === "run_pre_pr_checks") {
      const cycles = node.params.maxFixCycles;
      if (cycles !== undefined && (typeof cycles !== "number" || cycles < 0 || cycles > 5)) return false;
    }
  }
  return true;
}

export function WorkflowEditorScreen({
  initial,
  liveBlocks,
  canEdit,
}: {
  initial: WorkflowDefinitionResponse;
  liveBlocks: RunBlockStatusesResponse;
  canEdit: boolean;
}) {
  const seed = initial.current?.definition ?? initial.defaultDefinition;
  const [versions, setVersions] = useState<WorkflowDefinitionVersion[]>(initial.versions);
  const [nodes, setNodes] = useState<FlowNodeDef[]>(() => toViewNodes(seed.nodes));
  const [edges, setEdges] = useState<FlowEdgeDef[]>(() => structuredClone(seed.edges));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);

  const current = versions[0] ?? null;
  const baseline = current?.definition ?? initial.defaultDefinition;
  const dirty =
    JSON.stringify(serializeWorkflowDefinition(nodes, edges)) !==
    JSON.stringify(serializeWorkflowDefinition(baseline.nodes, baseline.edges));
  const canSave = (dirty || current === null) && nodesValid(nodes);

  const currentVersionNumber = current?.version ?? null;
  const run = liveBlocks.run;
  const derived = deriveRunStatuses(run, currentVersionNumber);

  let statusBar: React.ReactNode = null;
  if (derived && run) {
    const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name || id;
    const truncate = (s: string) => (s.length > 120 ? s.slice(0, 120) + "…" : s);
    const ids = Object.keys(derived.statuses);
    const runningId = ids.find((id) => derived.statuses[id] === "running");
    const failId = ids.find((id) => derived.statuses[id] === "fail");
    const warnId = ids.find((id) => derived.statuses[id] === "warn");

    let statusText: string;
    if (runningId) {
      statusText = `Running: ${nodeName(runningId)}`;
    } else if (run.status === "failed" || failId) {
      const where = failId ? nodeName(failId) : "run";
      const err = failId ? derived.errors[failId] : undefined;
      statusText = err ? `Failed at ${where}: ${truncate(err)}` : `Failed at ${where}`;
    } else if (warnId) {
      const err = derived.errors[warnId];
      statusText = err
        ? `Awaiting: questions on the ticket: ${truncate(err)}`
        : "Awaiting: questions on the ticket";
    } else {
      statusText = "Completed";
    }

    const ticketLabel = run.ticketKey ?? run.runId.slice(0, 8);
    statusBar = (
      <div className="flex items-center gap-2 px-6 py-2 border-b border-neutral-200 bg-app-bg font-body text-[12px] text-neutral-700">
        <span className="font-mono text-[11px] font-semibold text-coal">{ticketLabel}</span>
        <span className="rounded-full border border-neutral-200 bg-panel px-2 py-0.5 font-mono text-[10px] font-semibold tracking-[0.04em] uppercase text-neutral-600">
          {run.source === "live" ? "Live" : "Last run"}
        </span>
        <span className="truncate">{statusText}</span>
      </div>
    );
  }

  function applyVersion(version: WorkflowDefinitionVersion, refit: boolean) {
    setVersions((prev) => [version, ...prev]);
    setNodes(toViewNodes(version.definition.nodes));
    setEdges(structuredClone(version.definition.edges));
    if (refit) setFitSignal((s) => s + 1);
  }

  async function save() {
    setBusy("save");
    setError(null);
    try {
      const res = await fetch("/api/workflow-definition", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: serializeWorkflowDefinition(nodes, edges) }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      applyVersion(((await res.json()) as WorkflowDefinitionSaveResponse).version, false);
    } finally {
      setBusy(null);
    }
  }

  async function restore(version: number) {
    setBusy(`restore-${version}`);
    setError(null);
    try {
      const res = await fetch("/api/workflow-definition/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      applyVersion(((await res.json()) as WorkflowDefinitionSaveResponse).version, true);
      setConfirmRestore(null);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {current === null && (
        <div className="px-6 py-2 border-b border-neutral-200 bg-app-bg font-body text-[12px] text-neutral-600">
          Built-in default, save to create v1.
        </div>
      )}
      {statusBar}
      <div className="relative flex-1 min-h-0">
        <FlowEditor
          nodes={nodes}
          edges={edges}
          onNodesChange={setNodes}
          onEdgesChange={setEdges}
          canEdit={canEdit}
          dirty={dirty}
          saveEnabled={canSave}
          saving={busy === "save"}
          error={error}
          onSave={save}
          headerTitle="Ticket workflow"
          headerVersionBadge={current ? `v${current.version}` : "default"}
          headerExtra={
            <button
              onClick={() => setHistoryOpen((o) => !o)}
              className="appearance-none cursor-pointer border border-neutral-200 bg-panel text-coal py-1.5 px-3 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase hover:bg-app-bg"
            >
              History ({versions.length})
            </button>
          }
          options={initial.options}
          runStatuses={derived?.statuses}
          runErrors={derived?.errors}
          fitSignal={fitSignal}
        />
        {historyOpen && (
          <div className="absolute right-4 top-[56px] z-[60] w-[380px] max-h-[60vh] overflow-y-auto bg-panel border border-neutral-200 rounded-[4px] shadow-[0_12px_28px_-8px_rgba(24,27,32,0.22),0_2px_6px_rgba(24,27,32,0.08)] px-4 py-3">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-body text-[14px] font-semibold text-neutral-900">History</h2>
              <button
                onClick={() => setHistoryOpen(false)}
                className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
              >
                Close
              </button>
            </div>
            {versions.length === 0 && (
              <div className="font-body text-[12px] text-neutral-500">No versions yet.</div>
            )}
            {versions.map((v) => (
              <div
                key={v.version}
                className="flex items-center gap-3 border-b border-neutral-100 py-2 font-body text-[12px] text-neutral-700"
              >
                <span className="font-mono text-neutral-900">v{v.version}</span>
                <span>{v.createdByLabel}</span>
                <span className="text-neutral-400">{new Date(v.createdAt).toLocaleString()}</span>
                {v.restoredFromVersion !== null && (
                  <span className="rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[10px] text-neutral-600">
                    restored from v{v.restoredFromVersion}
                  </span>
                )}
                {canEdit && v.version !== versions[0]?.version && (
                  <span className="ml-auto">
                    {confirmRestore === v.version ? (
                      <>
                        <button
                          onClick={() => restore(v.version)}
                          disabled={busy !== null}
                          className="appearance-none border-none bg-transparent font-body text-[12px] font-semibold text-red-600 cursor-pointer disabled:opacity-40"
                        >
                          {busy === `restore-${v.version}` ? "Restoring…" : "Confirm restore"}
                        </button>
                        <button
                          onClick={() => setConfirmRestore(null)}
                          className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer ml-2"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmRestore(v.version)}
                        className="appearance-none border-none bg-transparent font-body text-[12px] text-mariner cursor-pointer"
                      >
                        Restore
                      </button>
                    )}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
