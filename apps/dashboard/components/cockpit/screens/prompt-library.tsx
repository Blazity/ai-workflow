"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CkCard } from "@/components/ui";
import { readErrorMessage } from "@/lib/api/error-message";
import { PromptListRail } from "@/components/cockpit/prompt-library/list-rail";
import { PromptDetail } from "@/components/cockpit/prompt-library/detail";
import {
  PromptEditorModal,
  type PromptEditorModalMeta,
} from "@/components/cockpit/flow-editor/prompt-editor-modal";
import { PromptLibraryProvider } from "@/components/cockpit/flow-editor/prompt-library-context";
import type { PromptInsertPayload } from "@/components/cockpit/flow-editor/prompt-insert-popup";
import type {
  PromptLibraryDetailResponse,
  PromptLibraryEntryMeta,
  PromptLibraryListResponse,
  PromptLibraryListRowDto,
  PromptLibrarySaveResponse,
  PromptLibraryUsageResponse,
} from "@shared/contracts";
import { initialPromptSelection } from "@/lib/prompt-library/query-selection";

const primaryButtonClass =
  "appearance-none cursor-pointer border border-mariner bg-mariner text-white py-1.5 px-3.5 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase disabled:opacity-40 disabled:cursor-default";

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}

function rowFrom(meta: PromptLibraryEntryMeta, body: string): PromptLibraryListRowDto {
  return { ...meta, body };
}

interface PromptDraft {
  name: string;
  description: string;
  tags: string[];
  body: string;
}

/** Edit/create both happen in the shared PromptEditorModal; the page behind it
 *  always shows the detail view. promptId is pinned at open time so a selection
 *  change behind the overlay can never redirect the save. */
interface EditorState {
  mode: "edit" | "create";
  promptId: number | null;
  draft: PromptDraft;
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
  const searchParams = useSearchParams();
  const requestedPrompt = searchParams.get("prompt");
  const [rows, setRows] = useState<PromptLibraryListRowDto[]>(data.prompts);
  const [activeId, setActiveId] = useState<number | null>(() =>
    initialPromptSelection(requestedPrompt, data.prompts),
  );
  const [editor, setEditor] = useState<EditorState | null>(null);
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
  const handledPromptQuery = useRef<string | null>(requestedPrompt);
  activeIdRef.current = activeId;

  // Lazily load the selected prompt's detail + usage in parallel and cache both.
  useEffect(() => {
    if (activeId === null) return;
    if (detailCache.has(activeId) && usageCache.has(activeId)) return;
    void loadDetail(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, retryNonce]);

  // CockpitShell's live-poll fires router.refresh() every ~5s, re-running the RSC
  // and handing us a fresh `data` object. Seeding `rows` once via useState would
  // otherwise drop those refreshes. Reconcile the fresh list into `rows`, but only
  // when it is safe: view mode with no pending navigation and no in-flight
  // mutation, so an open edit/create draft or an optimistic update is never
  // clobbered (view+idle has no local-only rows, so a wholesale replace is
  // correct). The effect keys solely on the stable `data` reference (new only on
  // an actual server refresh), so replacing `rows` here cannot loop.
  useEffect(() => {
    if (editor !== null || busy !== null) return;
    setRows(data.prompts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // A client-side query change is a real navigation request. Handle each query
  // value once; routine RSC refreshes must not pull the user back to the original
  // deep-linked prompt. Dirty drafts keep using the existing confirmation guard.
  useEffect(() => {
    if (handledPromptQuery.current === requestedPrompt) return;
    handledPromptQuery.current = requestedPrompt;
    if (requestedPrompt === null) return;
    // The query addresses prompts by slug (new links) or numeric id (legacy).
    // Only navigate when the query actually matched a row: the helper falls
    // back to the first row for unknown values, which is fine for initial
    // selection but must not yank an in-session user around.
    const selection = initialPromptSelection(requestedPrompt, rows);
    const matched = rows.some(
      (row) =>
        row.id === selection &&
        (row.slug === requestedPrompt || String(row.id) === requestedPrompt),
    );
    if (!matched || selection === activeId) return;

    // The editor modal blocks page interaction, so a query change can only
    // arrive in view state; navigate directly.
    setActiveId(selection);
    setError(null);
    setDetailErrorId(null);
  }, [activeId, requestedPrompt, rows]);

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
    setError(null);
    setDetailErrorId(null);
  }

  function openCreate() {
    setError(null);
    setEditor({
      mode: "create",
      promptId: null,
      draft: { name: "", description: "", tags: [], body: "" },
    });
  }

  function openEdit() {
    if (activeId === null) return;
    const detail = detailCache.get(activeId);
    if (!detail) return;
    setError(null);
    setEditor({
      mode: "edit",
      promptId: activeId,
      draft: {
        name: detail.meta.name,
        description: detail.meta.description ?? "",
        tags: detail.meta.tags,
        body: detail.current.body,
      },
    });
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
      setEditor(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create prompt");
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit(promptId: number, draft: PromptDraft) {
    const detail = detailCache.get(promptId);
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
        const res = await fetch(`/api/prompt-library/${promptId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: draft.body }),
        });
        if (!res.ok) {
          setError(await readErrorMessage(res));
          return;
        }
        applySave(promptId, (await res.json()) as PromptLibrarySaveResponse);
        // The head version changed, so cached usage drift is stale — re-fetch.
        await loadUsage(promptId);
      }
      if (metaChanged) {
        const res = await fetch(`/api/prompt-library/${promptId}`, {
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
      setEditor(null);
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
  const showEmptyState = available && noPrompts;

  const editorDetail = editor?.promptId != null ? detailCache.get(editor.promptId) : undefined;
  const editorBusy = busy === "create" || busy === "save";
  const editorDirty =
    editor !== null &&
    (editor.mode === "create"
      ? editor.draft.name.trim() !== "" ||
        editor.draft.body.trim() !== "" ||
        editor.draft.description.trim() !== "" ||
        editor.draft.tags.length > 0
      : editorDetail === undefined ||
        editor.draft.name !== editorDetail.meta.name ||
        editor.draft.description.trim() !== (editorDetail.meta.description ?? "").trim() ||
        !sameTags(editor.draft.tags, editorDetail.meta.tags) ||
        editor.draft.body !== editorDetail.current.body);
  const editorSubmitDisabled =
    editorBusy ||
    editor === null ||
    !editor.draft.name.trim() ||
    !editor.draft.body.trim() ||
    (editor.mode === "edit" && !editorDirty);

  function updateDraft(patch: Partial<PromptDraft>) {
    setEditor((prev) => (prev ? { ...prev, draft: { ...prev.draft, ...patch } } : prev));
  }

  // The rail decides replace-vs-append from the current content, mirroring the
  // block-field editor; provenance refs do not exist on library prompts.
  function applyEditorInsert(payload: PromptInsertPayload) {
    setEditor((prev) => {
      if (!prev) return prev;
      const body = payload.mode === "replace" || prev.draft.body.trim() === ""
        ? payload.text
        : `${prev.draft.body}\n\n${payload.text}`;
      return { ...prev, draft: { ...prev.draft, body } };
    });
  }

  let rightPane: ReactNode;
  if (activeRow && activeDetail === undefined && detailErrorId === activeId) {
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
        onEdit={openEdit}
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
    <PromptLibraryProvider>
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
          <button onClick={openCreate} className={primaryButtonClass}>
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
                <button onClick={openCreate} className={primaryButtonClass}>
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
            activeId={activeId}
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
          <div className="flex flex-col gap-3 min-w-0">{rightPane}</div>
        </div>
      )}

      {editor && (
        <PromptEditorModal
          open
          disabled={!canEdit}
          onClose={() => {
            setEditor(null);
            setError(null);
          }}
          value={editor.draft.body}
          onChange={(markdown) => updateDraft({ body: markdown })}
          onInsert={applyEditorInsert}
          blockName="Prompt library"
          fieldLabel={
            editor.mode === "create"
              ? "New prompt"
              : editorDetail?.meta.name ?? (editor.draft.name || "Edit prompt")
          }
          library={{
            meta: {
              name: editor.draft.name,
              description: editor.draft.description,
              tags: editor.draft.tags,
            },
            onMetaChange: (meta: PromptEditorModalMeta) => updateDraft(meta),
            primaryLabel:
              editor.mode === "create"
                ? "Create prompt"
                : `Save as v${(editorDetail?.meta.currentVersion ?? 0) + 1}`,
            primaryDisabled: editorSubmitDisabled,
            primaryBusy: editorBusy,
            onPrimary: () => {
              if (editorSubmitDisabled) return;
              const draft: PromptDraft = {
                ...editor.draft,
                name: editor.draft.name.trim(),
              };
              if (editor.mode === "create") void createPrompt(draft);
              else if (editor.promptId !== null) void saveEdit(editor.promptId, draft);
            },
            dirty: editorDirty,
            error,
            excludeId: editor.promptId ?? undefined,
          }}
        />
      )}
      </div>
    </PromptLibraryProvider>
  );
}
