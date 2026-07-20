"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CkCard } from "@/components/ui";
import { readErrorMessage } from "@/lib/api/error-message";
import { PromptListRail } from "@/components/cockpit/prompt-library/list-rail";
import { PromptDetail } from "@/components/cockpit/prompt-library/detail";
import { PromptEditorForm, type PromptDraft } from "@/components/cockpit/prompt-library/editor-form";
import type {
  PromptLibraryDetailResponse,
  PromptLibraryEntryMeta,
  PromptLibraryListResponse,
  PromptLibraryListRowDto,
  PromptLibrarySaveResponse,
  PromptLibraryUsageResponse,
} from "@shared/contracts";

const primaryButtonClass =
  "appearance-none cursor-pointer border border-mariner bg-mariner text-white py-1.5 px-3.5 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase disabled:opacity-40 disabled:cursor-default";

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}

function rowFrom(meta: PromptLibraryEntryMeta, body: string): PromptLibraryListRowDto {
  return { ...meta, body };
}

export function PromptLibraryScreen({
  data,
  canEdit,
  available,
}: {
  data: PromptLibraryListResponse;
  canEdit: boolean;
  available: boolean;
}) {
  const [rows, setRows] = useState<PromptLibraryListRowDto[]>(data.prompts);
  const [activeId, setActiveId] = useState<number | null>(
    data.prompts.find((p) => p.archivedAt === null)?.id ?? null,
  );
  const [mode, setMode] = useState<"view" | "edit" | "create">("view");
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Map<number, PromptLibraryDetailResponse>>(new Map());
  const [usageCache, setUsageCache] = useState<Map<number, PromptLibraryUsageResponse>>(new Map());
  // The prompt id whose lazy detail load failed, so the pane can offer a retry.
  const [detailErrorId, setDetailErrorId] = useState<number | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // Latest active id, so a slow failed fetch for a since-abandoned id stays quiet.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // Lazily load the selected prompt's detail + usage in parallel and cache both.
  useEffect(() => {
    if (activeId === null || mode === "create") return;
    if (detailCache.has(activeId) && usageCache.has(activeId)) return;
    void loadDetail(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, mode, retryNonce]);

  async function loadDetail(id: number) {
    try {
      const tasks: Promise<void>[] = [];
      if (!detailCache.has(id)) {
        tasks.push(
          (async () => {
            const res = await fetch(`/api/prompt-library/${id}`);
            if (!res.ok) {
              if (activeIdRef.current === id) {
                setError(await readErrorMessage(res));
                setDetailErrorId(id);
              }
              return;
            }
            const detail = (await res.json()) as PromptLibraryDetailResponse;
            setDetailCache((m) => new Map(m).set(id, detail));
          })(),
        );
      }
      if (!usageCache.has(id)) tasks.push(loadUsage(id));
      await Promise.all(tasks);
    } catch (err) {
      if (activeIdRef.current === id) {
        setError(err instanceof Error ? err.message : "Unable to load prompt");
        setDetailErrorId(id);
      }
    }
  }

  function retryDetail() {
    if (activeId === null) return;
    setError(null);
    setDetailErrorId(null);
    setRetryNonce((n) => n + 1);
  }

  // Usage drift depends on the head version, so a version bump must re-fetch it.
  async function loadUsage(id: number) {
    const res = await fetch(`/api/prompt-library/${id}/usage`);
    // Usage is supplementary; on failure cache an empty result so the "Used in"
    // card resolves instead of spinning forever.
    const usage = res.ok ? ((await res.json()) as PromptLibraryUsageResponse) : { rows: [] };
    setUsageCache((m) => new Map(m).set(id, usage));
  }

  function applyDetail(detail: PromptLibraryDetailResponse) {
    const id = detail.meta.id;
    const row = rowFrom(detail.meta, detail.current.body);
    setRows((prev) => (prev.some((r) => r.id === id) ? prev.map((r) => (r.id === id ? row : r)) : [row, ...prev]));
    setDetailCache((m) => new Map(m).set(id, detail));
  }

  function applySave(id: number, save: PromptLibrarySaveResponse) {
    setRows((prev) => prev.map((r) => (r.id === id ? rowFrom(save.meta, save.version.body) : r)));
    setDetailCache((m) => {
      const prev = m.get(id);
      const versions = prev
        ? [save.version, ...prev.versions.filter((v) => v.version !== save.version.version)].slice(0, 50)
        : [save.version];
      return new Map(m).set(id, { meta: save.meta, current: save.version, versions });
    });
  }

  function selectRow(id: number) {
    setActiveId(id);
    setMode("view");
    setError(null);
    setDetailErrorId(null);
  }

  async function createPrompt(draft: PromptDraft) {
    setBusy("create");
    setError(null);
    try {
      const res = await fetch("/api/prompt-library", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          body: draft.body,
          description: draft.description.trim() ? draft.description : undefined,
          tags: draft.tags.length ? draft.tags : undefined,
        }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      const detail = (await res.json()) as PromptLibraryDetailResponse;
      applyDetail(detail);
      setActiveId(detail.meta.id);
      setMode("view");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create prompt");
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit(draft: PromptDraft) {
    if (activeId === null) return;
    const detail = detailCache.get(activeId);
    if (!detail) return;
    const bodyChanged = draft.body !== detail.current.body;
    const descNext = draft.description.trim() ? draft.description : null;
    const metaChanged =
      draft.name !== detail.meta.name ||
      descNext !== detail.meta.description ||
      !sameTags(draft.tags, detail.meta.tags);

    setBusy("save");
    setError(null);
    try {
      if (bodyChanged) {
        const res = await fetch(`/api/prompt-library/${activeId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: draft.body }),
        });
        if (!res.ok) {
          setError(await readErrorMessage(res));
          return;
        }
        applySave(activeId, (await res.json()) as PromptLibrarySaveResponse);
        // The head version changed, so cached usage drift is stale — re-fetch.
        await loadUsage(activeId);
      }
      if (metaChanged) {
        const res = await fetch(`/api/prompt-library/${activeId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: draft.name, description: descNext, tags: draft.tags }),
        });
        if (!res.ok) {
          setError(await readErrorMessage(res));
          return;
        }
        // The PATCH response re-reads the full version list, so it already
        // reflects any version appended by the PUT above.
        applyDetail((await res.json()) as PromptLibraryDetailResponse);
      }
      setMode("view");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save prompt");
    } finally {
      setBusy(null);
    }
  }

  async function archive() {
    if (activeId === null) return;
    setBusy("archive");
    setError(null);
    try {
      const res = await fetch(`/api/prompt-library/${activeId}`, { method: "DELETE" });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      applyDetail((await res.json()) as PromptLibraryDetailResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to archive prompt");
    } finally {
      setBusy(null);
    }
  }

  async function restore(version: number) {
    if (activeId === null) return;
    setBusy(`restore-${version}`);
    setError(null);
    try {
      const res = await fetch(`/api/prompt-library/${activeId}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      applySave(activeId, (await res.json()) as PromptLibrarySaveResponse);
      // Restore appends a new head version but leaves activeId/mode unchanged, so
      // the lazy-load effect will not re-fetch — refresh usage drift explicitly.
      await loadUsage(activeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to restore version");
    } finally {
      setBusy(null);
    }
  }

  const activeRow = activeId !== null ? rows.find((r) => r.id === activeId) : undefined;
  const activeDetail = activeId !== null ? detailCache.get(activeId) : undefined;
  // Derive tag chips from the live rows so tags created mid-session appear, rather
  // than freezing on the static SSR data.tags snapshot.
  const tags = useMemo(() => [...new Set(rows.flatMap((r) => r.tags))].sort(), [rows]);
  const noPrompts = rows.length === 0;
  // The empty library shows its own "New prompt" CTA card, so the header button
  // would be a duplicate in that state.
  const showEmptyState = available && noPrompts && mode !== "create";

  let rightPane: ReactNode;
  if (mode === "create") {
    rightPane = (
      <PromptEditorForm
        mode="create"
        initialName=""
        initialDescription=""
        initialTags={[]}
        initialBody=""
        currentVersion={0}
        busy={busy === "create"}
        onSubmit={createPrompt}
        onCancel={() => setMode("view")}
      />
    );
  } else if (mode === "edit" && activeRow && activeDetail) {
    rightPane = (
      <PromptEditorForm
        mode="edit"
        initialName={activeDetail.meta.name}
        initialDescription={activeDetail.meta.description ?? ""}
        initialTags={activeDetail.meta.tags}
        initialBody={activeDetail.current.body}
        currentVersion={activeDetail.meta.currentVersion}
        busy={busy === "save"}
        onSubmit={saveEdit}
        onCancel={() => setMode("view")}
      />
    );
  } else if (activeRow && activeDetail === undefined && detailErrorId === activeId) {
    // A failed lazy load would otherwise strand the pane on the skeleton, and the
    // effect will not re-run for the same id, so offer an explicit retry.
    rightPane = (
      <CkCard style={{ height: "100%" }}>
        <div className="p-10 text-center font-body text-[13px] text-neutral-600">
          Could not load this prompt.{" "}
          <button
            type="button"
            onClick={retryDetail}
            className="appearance-none cursor-pointer border-none bg-transparent p-0 font-body text-[13px] font-semibold text-mariner"
          >
            Retry
          </button>
        </div>
      </CkCard>
    );
  } else if (activeRow) {
    rightPane = (
      <PromptDetail
        row={activeRow}
        detail={activeDetail}
        usage={activeId !== null ? usageCache.get(activeId) : undefined}
        canEdit={canEdit}
        busy={busy}
        onEdit={() => setMode("edit")}
        onArchive={archive}
        onRestore={restore}
      />
    );
  } else {
    rightPane = (
      <CkCard style={{ height: "100%" }}>
        <div className="p-10 text-center text-neutral-500 font-body">Select a prompt to inspect.</div>
      </CkCard>
    );
  }

  return (
    <div className="px-4 lg:px-6 pt-5 pb-8 flex flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] text-neutral-500 tracking-[0.06em] uppercase">
            Prompt library
          </div>
          <h2 className="font-display font-medium text-2xl leading-[1.2] m-0 text-neutral-900">
            Prompts
          </h2>
          <p className="font-body text-[13px] text-neutral-600 mt-1 m-0">
            Reusable prompts you can insert into workflow blocks.
          </p>
        </div>
        {canEdit && available && !showEmptyState && (
          <button onClick={() => {
            setMode("create");
            setError(null);
          }} className={primaryButtonClass}>
            New prompt
          </button>
        )}
      </div>

      {error && <div className="font-body text-[12px] text-red-600">{error}</div>}

      {!available ? (
        <div className="rounded-sm border border-neutral-200 bg-app-bg px-4 py-3 font-body text-[13px] text-neutral-700">
          Could not load the prompt library. Refresh to try again.
        </div>
      ) : showEmptyState ? (
        <div className="flex justify-center pt-10">
          <CkCard eyebrow="Prompt library" title="Build your prompt library" className="max-w-[520px]">
            <p className="font-body text-[13px] text-neutral-600 m-0">
              Reusable prompts you can insert into workflow blocks. Create the first one to get
              started.
            </p>
            {canEdit && (
              <div className="mt-4">
                <button onClick={() => setMode("create")} className={primaryButtonClass}>
                  New prompt
                </button>
              </div>
            )}
          </CkCard>
        </div>
      ) : (
        <div className="flex flex-col lg:grid lg:grid-cols-[340px_1fr] gap-3 lg:min-h-[720px]">
          <PromptListRail
            rows={rows}
            tags={tags}
            activeId={mode === "create" ? null : activeId}
            query={query}
            onQueryChange={setQuery}
            tag={tag}
            onTagChange={setTag}
            showArchived={showArchived}
            onToggleArchived={() => setShowArchived((v) => !v)}
            onSelect={selectRow}
            onClearFilters={() => {
              setQuery("");
              setTag(null);
              setShowArchived(false);
            }}
          />
          {rightPane}
        </div>
      )}
    </div>
  );
}
