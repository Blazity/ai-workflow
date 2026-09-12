"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  RepositoryCatalogImportCandidate,
  RepositoryCatalogImportPreviewResponse,
  RepositoryCatalogImportResponse,
  RepositoryProviderStatus,
} from "@shared/contracts";

import { apiClient } from "@/lib/api/client";
import {
  ALREADY_IN_CATALOG_NOTE,
  IMPORT_ENABLED_NOTE,
  PROVIDER_FAILED_NOTE,
  PROVIDER_UNAVAILABLE_NOTE,
  importDetails,
  importSummary,
  isProviderUnavailable,
  problemProviders,
  providerStatusLabel,
  selectableCandidates,
} from "@/lib/repository-catalog/import";

type Phase =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "listed" }
  | { kind: "done"; result: RepositoryCatalogImportResponse };

/**
 * Importing from the provider directory.
 *
 * Two calls, and the second one is checked against the first: the keys ticked
 * here are the keys the commit takes, which is why the preview is a POST rather
 * than a cached GET that could answer with a list the commit no longer accepts.
 *
 * A directory that could not be listed is an error state with a retry, never an
 * empty list presented as "nothing to import": a missing GitLab token and an
 * empty installation look identical in an empty list and only one of them is
 * something the admin can fix.
 */
export function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [candidates, setCandidates] = useState<RepositoryCatalogImportCandidate[]>([]);
  const [providers, setProviders] = useState<RepositoryProviderStatus[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [enabled, setEnabled] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    setError(null);
    try {
      const result = await apiClient.repositoryCatalog.importPreview();
      if (!result.ok) {
        setPhase({ kind: "failed", message: result.errorMessage });
        return;
      }
      const data = result.data as Partial<RepositoryCatalogImportPreviewResponse>;
      if (!Array.isArray(data.repositories) || !Array.isArray(data.providers)) {
        // A 200 carrying an unexpected body is as unusable as a bad status, and
        // rendering it as an empty directory would be the lie this state exists
        // to prevent.
        setPhase({ kind: "failed", message: "The directory listing was unreadable." });
        return;
      }
      setCandidates(data.repositories);
      setProviders(data.providers);
      setPhase({ kind: "listed" });
    } catch {
      setPhase({
        kind: "failed",
        message: "Could not reach the server. Check your connection and try again.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.repositoryCatalog.import([...selected], enabled);
      if (!result.ok) {
        setError(
          isProviderUnavailable({ status: result.status, message: result.errorMessage })
            ? PROVIDER_UNAVAILABLE_NOTE
            : result.errorMessage,
        );
        return;
      }
      setPhase({ kind: "done", result: result.data });
      onImported();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const listed = candidates.filter((candidate) =>
    candidate.path.toLowerCase().includes(filter.toLowerCase()),
  );
  // One definition of "a row an admin may tick", shared with the commit's own
  // selection rule rather than re-derived per row from the same two fields.
  const selectableKeys = new Set(
    selectableCandidates(candidates).map((candidate) => candidate.key),
  );
  const problems = problemProviders(providers);

  return (
    <section
      role="dialog"
      aria-label="Import repositories"
      className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="m-0 font-display text-[15px] font-medium text-coal">
          Import from the provider
        </h3>
        <button
          onClick={onClose}
          className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
        >
          Close
        </button>
      </div>

      {phase.kind === "loading" && (
        <p className="m-0 mt-2 font-body text-[12px] text-neutral-500">
          Listing what the installation exposes…
        </p>
      )}

      {phase.kind === "failed" && (
        <div className="mt-2">
          <div
            role="status"
            className="rounded-[3px] border border-red-300 bg-red-50 px-2 py-[6px] font-body text-[12px] text-red-700"
          >
            {PROVIDER_FAILED_NOTE}
          </div>
          <p className="m-0 mt-1 font-mono text-[11px] text-neutral-500">{phase.message}</p>
          <button
            onClick={() => void load()}
            className="mt-2 appearance-none rounded-[3px] border border-neutral-300 bg-white px-3 py-[6px] font-body text-[12px] text-neutral-800 cursor-pointer hover:bg-app-bg"
          >
            Retry
          </button>
        </div>
      )}

      {phase.kind === "done" && (
        <div className="mt-2">
          <p role="status" className="m-0 font-body text-[13px] text-neutral-800">
            {importSummary(phase.result)}
          </p>
          {importDetails(phase.result).map((detail) => (
            <div key={detail.label} className="mt-2">
              <div className="font-body text-[11px] text-neutral-600">{detail.label}:</div>
              <ul className="list-none m-0 mt-[2px] p-0">
                {detail.keys.map((key) => (
                  <li key={key} className="font-mono text-[11px] text-neutral-700">
                    {key}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <button
            onClick={onClose}
            className="mt-3 appearance-none border-none rounded-[3px] bg-mariner px-4 py-2 font-body text-[13px] font-semibold text-white cursor-pointer"
          >
            Done
          </button>
        </div>
      )}

      {phase.kind === "listed" && (
        <>
          {problems.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {problems.map((provider) => (
                <div
                  key={provider.provider}
                  role="status"
                  className="rounded-[3px] border border-red-200 bg-red-50 px-2 py-[6px] font-body text-[11px] text-red-700"
                >
                  {provider.provider}: {providerStatusLabel(provider)}. This list does not
                  include its repositories.
                </div>
              ))}
            </div>
          )}

          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter…"
            aria-label="Filter repositories"
            className="mt-2 w-full rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-mono text-[12px]"
          />

          {listed.length === 0 ? (
            <p className="m-0 mt-2 font-body text-[12px] text-neutral-500">
              {candidates.length === 0
                ? "Every provider answered, and none of them exposes a repository."
                : "Nothing matches the filter."}
            </p>
          ) : (
            <div className="mt-2 max-h-[280px] overflow-y-auto">
              {listed.map((candidate) => {
                const held = candidate.inCatalog;
                const selectable = selectableKeys.has(candidate.key);
                return (
                  <label
                    key={candidate.key}
                    className={`flex items-center gap-2 px-1 py-[6px] ${
                      held ? "opacity-60" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      // A repository the catalog already holds is ticked off
                      // and cannot be untickedly imported again: the insert
                      // does nothing on conflict, and offering the click would
                      // promise something the import cannot do.
                      checked={held || selected.has(candidate.key)}
                      disabled={!selectable}
                      onChange={() => toggle(candidate.key)}
                    />
                    <span className="font-mono text-[12px] text-neutral-800">
                      {candidate.path}
                    </span>
                    <span className="rounded-[3px] bg-app-bg px-[5px] py-[1px] font-mono text-[10px] uppercase text-neutral-500">
                      {candidate.provider}
                    </span>
                    {candidate.archived && !held && (
                      <span className="font-body text-[11px] text-neutral-500">archived</span>
                    )}
                    {held && (
                      <span className="font-body text-[11px] text-neutral-500">
                        {ALREADY_IN_CATALOG_NOTE}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          <label className="mt-3 flex items-center gap-2 font-body text-[12px] text-neutral-800">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Let the agent touch these repositories
          </label>
          <p className="m-0 mt-1 font-body text-[10px] text-neutral-500">
            {IMPORT_ENABLED_NOTE}
          </p>

          {error && (
            <div
              role="status"
              className="mt-2 rounded-[3px] border border-red-300 bg-red-50 px-2 py-[6px] font-body text-[12px] text-red-700"
            >
              {error}
            </div>
          )}

          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={commit}
              disabled={selected.size === 0 || busy}
              className="appearance-none border-none rounded-[3px] bg-mariner px-4 py-2 font-body text-[13px] font-semibold text-white cursor-pointer disabled:opacity-40 disabled:cursor-default"
            >
              {busy ? "Importing…" : `Import ${selected.size}`}
            </button>
            {selected.size === 0 && (
              <span className="font-body text-[11px] text-neutral-500">
                Tick at least one repository.
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
