// apps/dashboard/app/prompt-library-data.tsx
import { getJSON, authAwareFallback } from "@/lib/api/server";
import { requireSession } from "@/lib/auth/session";
import { PromptLibraryScreen } from "@/components/cockpit/screens/prompt-library";
import type { PromptLibraryListResponse } from "@shared/contracts";

export async function PromptLibraryData() {
  const session = await requireSession();
  // Archived prompts stay visible (dimmed) behind a toggle, so pull them in the
  // one server fetch and let the client filter locally.
  const loaded = await getJSON<PromptLibraryListResponse>(
    "/api/v1/prompt-library?includeArchived=1",
  ).catch((e) => authAwareFallback(e, (): PromptLibraryListResponse | null => null));
  const available = loaded !== null;
  const data = loaded ?? { prompts: [], tags: [] };
  return (
    <PromptLibraryScreen data={data} canEdit={session.canEditWorkflows} available={available} />
  );
}
