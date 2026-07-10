import { redirect } from "next/navigation";

import { getJSON } from "@/lib/api/server";
import { UnauthorizedError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/session";
import { WorkflowEditorScreen } from "@/components/cockpit/screens/workflow-editor";
import type { WorkflowDefinitionResponse } from "@shared/contracts";

export async function EditorData() {
  try {
    const [session, data] = await Promise.all([
      requireSession(),
      getJSON<WorkflowDefinitionResponse>("/api/v1/workflow-definition"),
    ]);
    return <WorkflowEditorScreen initial={data} canEdit={session.canEditWorkflows} />;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect("/login");
    }
    throw error;
  }
}
