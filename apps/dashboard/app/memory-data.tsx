// apps/dashboard/app/memory-data.tsx
import { redirect } from "next/navigation";

import { getJSON, withQuery } from "@/lib/api/server";
import { UnauthorizedError } from "@/lib/auth/errors";
import { requireSession, type DashboardSession } from "@/lib/auth/session";
import { MemoryScreen } from "@/components/cockpit/screens/memory";
import type {
  MemoryDocumentResponse,
  MemoryDocumentsResponse,
} from "@shared/contracts";

/** getJSON puts the status into the error message (lib/api/server.ts), which is
 *  the only way to tell a missing document from a broken worker. */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes("→ 404");
}

/** Mirrors canDeleteAgentMemory on the worker, which is what actually enforces
 *  the rule; this only hides an action that would come back 403. */
function canDeleteMemory(role: DashboardSession["role"]): boolean {
  return role === "owner" || role === "admin";
}

export async function MemoryData({
  subjectKey,
  docPath,
}: {
  subjectKey?: string;
  docPath?: string;
}) {
  const selection =
    subjectKey && docPath ? { subjectKey, docPath } : null;
  try {
    const [session, list, detail] = await Promise.all([
      requireSession(),
      getJSON<MemoryDocumentsResponse>("/api/v1/memory"),
      selection
        ? getJSON<MemoryDocumentResponse>(
            withQuery("/api/v1/memory", selection),
          ).catch((error) => {
            // Only a stale link (the document was replaced or dropped) renders
            // the empty preview; a worker failure or timeout must still surface.
            if (!isNotFound(error)) throw error;
            return null;
          })
        : null,
    ]);
    return (
      <MemoryScreen
        documents={list.documents}
        selection={selection}
        selected={detail?.document ?? null}
        canDelete={canDeleteMemory(session.role)}
      />
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect("/login");
    }
    throw error;
  }
}
