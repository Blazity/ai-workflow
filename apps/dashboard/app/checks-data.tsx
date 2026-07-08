import { redirect } from "next/navigation";

import { getJSON } from "@/lib/api/server";
import { UnauthorizedError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/session";
import { PrePrChecksScreen } from "@/components/cockpit/screens/pre-pr-checks";
import type { PrePrChecksResponse } from "@shared/contracts";

export async function ChecksData() {
  try {
    const [session, checks] = await Promise.all([
      requireSession(),
      getJSON<PrePrChecksResponse>("/api/v1/pre-pr-checks"),
    ]);
    return <PrePrChecksScreen initial={checks} canEdit={session.canEditChecks} />;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect("/login");
    }
    throw error;
  }
}
