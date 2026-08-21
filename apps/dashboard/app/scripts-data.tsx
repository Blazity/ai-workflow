import { redirect } from "next/navigation";

import { getJSON } from "@/lib/api/server";
import { UnauthorizedError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/session";
import { RepositoryScriptsScreen } from "@/components/cockpit/screens/repository-scripts";
import type { PrePrChecksResponse } from "@shared/contracts";

export async function ScriptsData() {
  try {
    const [session, checks] = await Promise.all([
      requireSession(),
      getJSON<PrePrChecksResponse>("/api/v1/pre-pr-checks"),
    ]);
    return <RepositoryScriptsScreen initial={checks} canEdit={session.canEditChecks} />;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect("/login");
    }
    throw error;
  }
}
