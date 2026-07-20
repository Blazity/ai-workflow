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

export async function EditorData() {
  const now = new Date().toISOString();
  try {
    const [session, list, liveBlocks] = await Promise.all([
      requireSession(),
      getJSON<WorkflowDefinitionsResponse>("/api/v1/workflow-definitions"),
      getJSON<RunBlockStatusesResponse>("/api/v1/runs/block-statuses").catch((e) =>
        authAwareFallback(e, (): RunBlockStatusesResponse => ({ generatedAt: now, run: null })),
      ),
    ]);
    const initialMeta =
      list.definitions.find((d) => d.enabled && d.triggerTypes.includes("trigger_ticket_ai")) ??
      list.definitions[0];
    if (!initialMeta) throw new Error("No workflow definitions available");
    const initialDetail = await getJSON<WorkflowDefinitionDetailResponse>(
      `/api/v1/workflow-definitions/${initialMeta.id}`,
    );
    return (
      <WorkflowEditorScreen
        definitions={list.definitions}
        templates={
          list.templates ?? [
            {
              id: "ticket-workflow",
              name: "Ticket workflow",
              description: "The current production delivery workflow.",
              definition: list.defaultDefinition,
            },
          ]
        }
        initialDetail={initialDetail}
        defaultDefinition={list.defaultDefinition}
        options={list.options}
        liveBlocks={liveBlocks}
        canEdit={session.canEditWorkflows}
      />
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect("/login");
    }
    throw error;
  }
}
