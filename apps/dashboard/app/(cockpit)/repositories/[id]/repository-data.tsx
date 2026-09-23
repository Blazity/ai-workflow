import { notFound, redirect } from "next/navigation";

import { canManageRepositoryCatalog, repoSubjectKey } from "@shared/contracts";
import type {
  MemoryDocumentResponse,
  MemoryDocumentsResponse,
  PrePrChecksResponse,
  RepositoryCatalogEntryResponse,
  RepositoryCatalogListResponse,
  RepositoryCatalogVersionsResponse,
} from "@shared/contracts";

import { getJSON, withQuery } from "@/lib/api/server";
import { isWorkerStatus } from "@/lib/api/worker-errors";
import { UnauthorizedError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/session";

import {
  RepositoryEntryScreen,
  type RepositoryMemory,
  type RepositoryMemorySlot,
} from "../repository-entry";

/** A missing row, told apart from a broken worker by the status getJSON
 *  carries on what it throws. */
function isNotFound(error: unknown): boolean {
  return isWorkerStatus(error, 404);
}

/**
 * The two statuses the worker answers when this deployment's memory provider
 * could not be asked: 503 for one that is away (asking again may work), 501
 * for one that serves runs and cannot list what it holds (asking again will
 * not). Either is a state the tab shows, never an empty tab and never an error
 * that takes the profile editor down with it.
 */
function memoryRefusal(error: unknown): { retryable: boolean; reason: string } | null {
  if (!isWorkerStatus(error, 503, 501)) return null;
  return {
    retryable: error.status === 503,
    reason: error.reason ?? "This deployment's memory could not be read.",
  };
}

/**
 * This repository's documents, as this deployment's memory provider lists them.
 *
 * The listing is the only source of what exists: a document is read, and later
 * erased, by exactly the pair the listing returned, and the page never names a
 * document itself. A provider keeps whatever documents it keeps, under names
 * it chooses; only the subject key is core's address, so it is built by core's
 * one helper and matched exactly.
 */
async function repositoryMemory(subjectKey: string): Promise<RepositoryMemory> {
  let listing: MemoryDocumentsResponse;
  try {
    listing = await getJSON<MemoryDocumentsResponse>("/api/v1/memory");
  } catch (error) {
    const refusal = memoryRefusal(error);
    if (refusal === null) throw error;
    return { state: "unavailable", ...refusal };
  }
  const pairs = listing.documents
    .filter((listed) => listed.subjectKey === subjectKey)
    .sort((left, right) => left.docPath.localeCompare(right.docPath));
  const documents = await Promise.all(
    pairs.map(async ({ subjectKey: key, docPath }): Promise<RepositoryMemorySlot> => {
      try {
        const read = await getJSON<MemoryDocumentResponse>(
          withQuery("/api/v1/memory", { subjectKey: key, docPath }),
        );
        return { subjectKey: key, docPath, document: read.document, unreadable: null };
      } catch (error) {
        // The listing answered and this one read did not. Carried as the
        // provider's sentence, never as a missing document: telling somebody a
        // document is gone when nobody erased it is the answer a 503 exists to
        // prevent.
        const refusal = memoryRefusal(error);
        if (refusal !== null) {
          return { subjectKey: key, docPath, document: null, unreadable: refusal.reason };
        }
        // Erased between the listing and the read: the slot says so.
        if (isNotFound(error)) return { subjectKey: key, docPath, document: null, unreadable: null };
        throw error;
      }
    }),
  );
  // Absent reads as complete: a worker built before the field cannot answer
  // either way, and complete is how its screen already read it.
  return { state: "listed", complete: listing.complete ?? true, documents };
}

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

    const subjectKey = repoSubjectKey(entry.repository.provider, entry.repository.path);

    const [versions, catalog, checks, memory] = await Promise.all([
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
      repositoryMemory(subjectKey),
    ]);

    return (
      <RepositoryEntryScreen
        repository={entry.repository}
        currentProfile={entry.currentProfile}
        versions={versions.versions}
        versionsHasMore={versions.hasMore}
        catalog={catalog?.repositories ?? []}
        allowedEnv={checks?.allowedEnv}
        memory={memory}
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
