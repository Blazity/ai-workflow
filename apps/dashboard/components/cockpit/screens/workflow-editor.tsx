"use client";

import { FlowEditor } from "@/components/cockpit/screens/flow-editor";
import { useCockpit } from "@/components/cockpit/context";
import { FLOWS, DEFAULT_FLOW_ID } from "@/lib/flows";

export function WorkflowEditorScreen() {
  const { t, setTweak } = useCockpit();

  // Resolve the persisted selection; fall back if a stale id is stored.
  const entry =
    FLOWS.find((e) => e.flow.id === t.editorFlow) ??
    FLOWS.find((e) => e.flow.id === DEFAULT_FLOW_ID)!;

  return (
    <FlowEditor
      flow={entry.flow}
      runStatuses={entry.runStatuses}
      subtitle={entry.subtitle}
      flows={FLOWS.map((e) => ({ id: e.flow.id, label: e.label }))}
      flowId={entry.flow.id}
      onSelectFlow={(id) => setTweak("editorFlow", id)}
    />
  );
}
