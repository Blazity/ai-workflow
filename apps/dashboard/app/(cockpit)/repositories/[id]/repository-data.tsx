import { notFound, redirect } from "next/navigation";

import { canManageRepositoryCatalog } from "@shared/contracts";
import type {
  MemoryDocumentResponse,
  PrePrChecksResponse,
  RepositoryCatalogEntryResponse,
  RepositoryCatalogListResponse,
  RepositoryCatalogVersionsResponse,
} from "@shared/contracts";

import { getJSON, withQuery } from "@/lib/api/server";
import { UnauthorizedError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/session";

import { RepositoryEntryScreen } from "../repository-entry";

/** getJSON puts the status into the error message (lib/api/server.ts), which is
 *  the only way to tell a missing row from a broken worker. */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes("→ 404");
}

/** Repository-scoped agent memory is two documents under one subject key, which
 *  the worker spells `repo:<provider>:<path>` (apps/worker/src/memory). */
const MEMORY_DOC_PATHS = ["facts", "lessons"] as const;

export async function RepositoryData({ id }: { id: number }) {
  try {
    const session = await requireSession();
    const entry = await getJSON<RepositoryCatalogEntryResponse>(
      `/api/v1/repository-catalog/${id}`,
    ).catch((error) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (entry === null) notFound();

    const subjectKey = `repo:${entry.repository.provider}:${entry.repository.path}`;

    const [versions, catalog, checks, ...memory] = await Promise.all([
      // The History tab's FIRST PAGE. Loaded with the page rather than on the
      // tab click: it is one small query and a tab that has to fetch before it
      // can say anything is a tab that shows a spinner every time it is opened.
      // The route is paged, so this is the newest page and the tab asks for
      // older ones; `hasMore` is what puts the button there.
      getJSON<RepositoryCatalogVersionsResponse>(
        `/api/v1/repository-catalog/${id}/versions`,
      ).catch((): RepositoryCatalogVersionsResponse => ({
        versions: [],
        hasMore: false,
      })),
      // Relationships point at catalog ids, and an id is not a name.
      getJSON<RepositoryCatalogListResponse>("/api/v1/repository-catalog").catch(
        (): RepositoryCatalogListResponse | null => null,
      ),
      // The env allowlist this deployment forwards, which is deployment state
      // rather than configuration. A worker that does not report it answers
      // without the field, and the editor then offers no chips and makes no
      // accusations, which is not the same as an empty allowlist.
      getJSON<PrePrChecksResponse>("/api/v1/pre-pr-checks").catch(
        (): PrePrChecksResponse | null => null,
      ),
      ...MEMORY_DOC_PATHS.map((docPath) =>
        getJSON<MemoryDocumentResponse>(
          withQuery("/api/v1/memory", { subjectKey, docPath }),
        ).catch((error) => {
          // A repository with no memory yet is the ordinary case, not a
          // failure; anything else still surfaces.
          if (isNotFound(error)) return null;
          throw error;
        }),
      ),
    ]);

    return (
      <RepositoryEntryScreen
        repository={entry.repository}
        currentProfile={entry.currentProfile}
        versions={versions.versions}
        versionsHasMore={versions.hasMore}
        catalog={catalog?.repositories ?? []}
        allowedEnv={checks?.allowedEnv}
        memory={MEMORY_DOC_PATHS.map((docPath, index) => ({
          docPath,
          subjectKey,
          document: memory[index]?.document ?? null,
        }))}
        canManage={canManageRepositoryCatalog(session.role)}
      />
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect("/login");
    }
    throw error;
  }
}
