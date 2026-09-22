// apps/dashboard/app/memory-data.tsx
import { redirect } from "next/navigation";

import { canEditSettings } from "@shared/contracts";
import { getJSON, withQuery } from "@/lib/api/server";
import { UnauthorizedError } from "@/lib/auth/errors";
import { requireSession, type DashboardSession } from "@/lib/auth/session";
import { MemoryScreen } from "@/components/cockpit/screens/memory";
import type {
  MemoryDocumentResponse,
  MemoryDocumentsResponse,
  SettingsReadResponse,
} from "@shared/contracts";

/** getJSON puts the status into the error message (lib/api/server.ts), which is
 *  the only way to tell a missing document from a broken worker. */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes("→ 404");
}

/**
 * The two statuses the worker answers when this deployment's memory provider
 * could not be read: 503 for a provider that is away, 501 for one that serves
 * runs and has no enumerable store at all.
 *
 * Both land on the page as a sentence rather than as an error boundary, and
 * NEITHER may land as an empty list. A person who reads "nothing remembered
 * yet" for a store nobody could read concludes their agent has forgotten
 * everything, which is the one wrong answer this screen can give.
 */
function providerUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("→ 503") || error.message.includes("→ 501"))
  );
}

/** The worker puts its reason in the status message, after the arrow. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const [, reason] = message.split(/→ \d+ /);
  return reason?.trim() ? reason.trim() : "This deployment's memory could not be read.";
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
    const [session, list, detail, settings] = await Promise.all([
      requireSession(),
      getJSON<MemoryDocumentsResponse>("/api/v1/memory").catch(
        (error): MemoryDocumentsResponse | { unavailable: string } => {
          if (!providerUnavailable(error)) throw error;
          return { unavailable: reasonOf(error) };
        },
      ),
      selection
        ? getJSON<MemoryDocumentResponse>(
            withQuery("/api/v1/memory", selection),
          ).catch(
            (
              error,
            ): MemoryDocumentResponse | { unavailable: string } | null => {
              // The provider could not answer this read. It is carried as a
              // sentence, NEVER as null: null is what the card renders as "this
              // document is no longer stored", and telling somebody their memory
              // is gone when nobody deleted anything is the exact answer the
              // worker's 503 exists to prevent. The listing can succeed while
              // one read fails, so this is not covered by the listing above.
              if (providerUnavailable(error)) {
                return { unavailable: reasonOf(error) };
              }
              // Only a stale link (the document was replaced or dropped) renders
              // the empty preview; a worker failure or timeout must still
              // surface.
              if (!isNotFound(error)) throw error;
              return null;
            },
          )
        : null,
      // The memory switches are a panel on this page, not its subject: a
      // settings read that fails leaves the documents on screen and drops the
      // panel rather than taking the page down with it.
      getJSON<SettingsReadResponse>("/api/v1/settings").catch(
        (): SettingsReadResponse | null => null,
      ),
    ]);
    const unavailable = "unavailable" in list ? list.unavailable : null;
    const selectedUnavailable =
      detail && "unavailable" in detail ? detail.unavailable : null;
    return (
      <MemoryScreen
        documents={"documents" in list ? list.documents : []}
        // Absent means the answer came from a worker built before the field
        // existed, which cannot tell us either way. It reads as complete
        // because that is exactly how that build's screen read it, so an older
        // worker keeps the behaviour it had rather than gaining a notice
        // nothing behind it can decide.
        complete={"documents" in list ? (list.complete ?? true) : true}
        unavailable={unavailable}
        selection={selection}
        selected={detail && "document" in detail ? detail.document : null}
        selectedUnavailable={selectedUnavailable}
        canDelete={canDeleteMemory(session.role)}
        settings={settings?.settings ?? []}
        canEditSettings={canEditSettings(session.role)}
      />
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect("/login");
    }
    throw error;
  }
}
