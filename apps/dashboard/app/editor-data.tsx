import { redirect } from "next/navigation";

import { getJSON, authAwareFallback } from "@/lib/api/server";
import { UnauthorizedError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/session";
import { WorkflowEditorScreen } from "@/components/cockpit/screens/workflow-editor";
import type { RunBlockStatusesResponse, WorkflowDefinitionResponse } from "@shared/contracts";

export async function EditorData() {
  const now = new Date().toISOString();
  try {
    const [session, data, liveBlocks] = await Promise.all([
      requireSession(),
      getJSON<WorkflowDefinitionResponse>("/api/v1/workflow-definition"),
      getJSON<RunBlockStatusesResponse>("/api/v1/runs/block-statuses").catch((e) =>
        authAwareFallback(e, (): RunBlockStatusesResponse => ({ generatedAt: now, run: null })),
      ),
    ]);
    return (
      <WorkflowEditorScreen
        initial={data}
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
