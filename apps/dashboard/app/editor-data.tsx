import { redirect } from "next/navigation";

import { getJSON, authAwareFallback } from "@/lib/api/server";
import { UnauthorizedError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/session";
import { WorkflowEditorScreen } from "@/components/cockpit/screens/workflow-editor";
import type {
  RunBlockStatusesResponse,
  WorkflowDefinitionDetailResponse,
  WorkflowDefinitionsResponse,
} from "@shared/contracts";

export async function EditorData({
  definitionId,
  nodeId,
}: { definitionId?: number; nodeId?: string } = {}) {
  const now = new Date().toISOString();
  try {
    const [session, list, liveBlocks] = await Promise.all([
      requireSession(),
      getJSON<WorkflowDefinitionsResponse>("/api/v1/workflow-definitions"),
      getJSON<RunBlockStatusesResponse>("/api/v1/runs/block-statuses").catch((e) =>
        authAwareFallback(e, (): RunBlockStatusesResponse => ({ generatedAt: now, run: null })),
      ),
    ]);
    // Deep link wins when it names a definition that exists; otherwise fall back
    // to the AI-trigger default (invalid params are ignored silently).
    const requested =
      definitionId !== undefined ? list.definitions.find((d) => d.id === definitionId) : undefined;
    const initialMeta =
      requested ??
      list.definitions.find((d) => d.enabled && d.triggerTypes.includes("trigger_ticket_ai")) ??
      list.definitions[0];
    if (!initialMeta) throw new Error("No workflow definitions available");
    const initialDetail = await getJSON<WorkflowDefinitionDetailResponse>(
      `/api/v1/workflow-definitions/${initialMeta.id}`,
    );
    return (
      <WorkflowEditorScreen
        definitions={list.definitions}
        initialDetail={initialDetail}
        defaultDefinition={list.defaultDefinition}
        options={list.options}
        liveBlocks={liveBlocks}
        canEdit={session.canEditWorkflows}
        initialNodeId={nodeId}
      />
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect("/login");
    }
    throw error;
  }
}
