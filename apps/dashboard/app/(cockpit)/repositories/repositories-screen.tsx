"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import type {
  RepositoryCatalogEntry,
  RepositoryCatalogState,
} from "@shared/contracts";

import { apiClient } from "@/lib/api/client";
import { NOT_ACTIVATED_BANNER } from "@/lib/repository-catalog/activation";
import {
  firstLine,
  formatDateTime,
  sortRepositories,
  sourceLabel,
} from "@/lib/repository-catalog/format";

import { ActivateDialog } from "./activate-dialog";
import { ImportDialog } from "./import-dialog";

/**
 * What the list can honestly say about a repository's checks.
 *
 * The list response carries the row, not the profile, so the number of script
 * groups is not on it. `checksVersion` is: it moves only when the script groups
 * or the gate selection change, so 0 is "no checks have ever been configured"
 * and anything else is the version the publication gate records. A count
 * invented from a field that does not carry one would be worse than a version
 * that is true.
 */
function checksLabel(repository: RepositoryCatalogEntry): string {
  return repository.checksVersion === 0
    ? "no script groups"
    : `script groups v${repository.checksVersion}`;
}

function EnabledSwitch({
  repository,
  canManage,
  onChanged,
}: {
  repository: RepositoryCatalogEntry;
  canManage: boolean;
  onChanged: (next: RepositoryCatalogEntry, warnings: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canManage) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-600">
        {repository.enabled ? "enabled" : "not enabled"}
      </span>
    );
  }

  return (
    <span className="flex flex-col items-end gap-[2px]">
      <label className="flex items-center gap-[6px] font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-600">
        <input
          type="checkbox"
          checked={repository.enabled}
          disabled={busy}
          aria-label={`Let the agent touch ${repository.path}`}
          onChange={async (event) => {
            const next = event.target.checked;
            setBusy(true);
            setError(null);
            try {
              const result = await apiClient.repositoryCatalog.setEnabled(
                repository.id,
                next,
              );
              if (!result.ok) {
                setError(result.errorMessage);
                return;
              }
              onChanged(result.data.repository, result.data.warnings ?? []);
            } catch {
              setError("Could not reach the server.");
            } finally {
              setBusy(false);
            }
          }}
        />
        {repository.enabled ? "enabled" : "not enabled"}
      </label>
      {error && (
        <span role="status" className="font-body text-[10px] text-red-600">
          {error}
        </span>
      )}
    </span>
  );
}

export function RepositoriesScreen({
  state,
  repositories,
  canManage,
  available,
}: {
  state: RepositoryCatalogState | null;
  repositories: readonly RepositoryCatalogEntry[];
  /** canManageRepositoryCatalog(role): owners and admins. */
  canManage: boolean;
  /** False when the worker did not answer the catalog read. */
  available: boolean;
}) {
  const router = useRouter();
  // The list is the server's, not this component's. Seeding state from props
  // once meant `router.refresh()` after an import re-rendered with a longer
  // list that nothing on screen read, and the Activate dialog counted the old
  // rows. So the rows are derived, and the only thing held locally is the
  // optimistic replacement the enabled switch makes while the refresh lands.
  const [overrides, setOverrides] = useState<Record<number, RepositoryCatalogEntry>>({});
  const [activated, setActivated] = useState<RepositoryCatalogState | null>(null);
  const [dialog, setDialog] = useState<"none" | "activate" | "import">("none");
  const [warnings, setWarnings] = useState<string[]>([]);

  // A fresh server render supersedes every optimistic row: keeping one would
  // shadow the value the refresh was fetched to show.
  useEffect(() => {
    setOverrides({});
    setActivated(null);
  }, [repositories, state]);

  const rows = useMemo(
    () => sortRepositories(repositories.map((row) => overrides[row.id] ?? row)),
    [repositories, overrides],
  );
  const catalogState = activated ?? state;

  function replaceRow(next: RepositoryCatalogEntry, nextWarnings: string[]) {
    setOverrides((prev) => ({ ...prev, [next.id]: next }));
    setWarnings(nextWarnings);
  }

  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6 pt-5 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
            Repositories
          </div>
          <h2 className="m-0 font-display text-2xl font-medium leading-[1.2] text-neutral-900">
            Repository catalog
          </h2>
          <p className="m-0 font-body text-[13px] text-neutral-600">
            Every repository this deployment has decided something about: what
            the agent may touch, what it should know, and what its checks run.
          </p>
        </div>
        {canManage && available && (
          <button
            onClick={() => setDialog(dialog === "import" ? "none" : "import")}
            className="appearance-none rounded-[3px] border border-neutral-300 bg-panel px-3 py-2 font-body text-[13px] text-neutral-800 cursor-pointer hover:bg-app-bg"
          >
            Import
          </button>
        )}
      </div>

      {!available && (
        <div className="rounded-[3px] border border-[#F0B8AE] bg-fail-bg px-3 py-2 font-body text-[12px] text-fail-fg">
          {canManage
            ? "The worker did not answer, so nothing can be shown or changed here. Check the worker on the System health page and reload."
            : "The worker did not answer, so nothing can be shown here. Ask an owner or admin to check the worker, then reload."}
        </div>
      )}

      {available && catalogState !== null && !catalogState.activated && (
        <div className="rounded-[3px] border border-orange-300 bg-orange-100 px-3 py-2 font-body text-[12px] text-[#A23E18]">
          <span>{NOT_ACTIVATED_BANNER}.</span>{" "}
          {canManage ? (
            <button
              onClick={() => setDialog(dialog === "activate" ? "none" : "activate")}
              className="appearance-none border-none bg-transparent px-0 font-body text-[12px] font-semibold text-[#A23E18] underline cursor-pointer"
            >
              Activate
            </button>
          ) : (
            <span>Ask an owner or admin to activate it.</span>
          )}
        </div>
      )}

      {available && catalogState?.activated && (
        <div className="rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[12px] text-neutral-600">
          Catalog activated
          {catalogState.activatedByLabel ? ` by ${catalogState.activatedByLabel}` : ""}
          {catalogState.activatedAt ? ` on ${formatDateTime(catalogState.activatedAt)}` : ""}
          . Dispatch selects only the repositories enabled here.
        </div>
      )}

      {available && !canManage && (
        <div className="rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[12px] text-neutral-600">
          Read-only: every repository is shown, and changing one needs the owner
          or admin role.
        </div>
      )}

      {warnings.length > 0 && (
        <div
          role="status"
          className="rounded-[3px] border border-orange-300 bg-orange-100 px-3 py-2 font-body text-[12px] text-[#A23E18]"
        >
          {warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      )}

      {dialog === "activate" && (
        <ActivateDialog
          repositories={rows}
          onClose={() => setDialog("none")}
          onActivated={(next) => {
            setActivated(next);
            setDialog("none");
            router.refresh();
          }}
        />
      )}

      {dialog === "import" && (
        <ImportDialog
          onClose={() => setDialog("none")}
          onImported={() => router.refresh()}
        />
      )}

      {available && rows.length === 0 && (
        <div className="rounded-[3px] border border-dashed border-neutral-300 px-4 py-8 text-center">
          <p className="m-0 font-body text-[13px] text-neutral-600">
            The catalog is empty. Import the repositories this installation
            exposes, then enable the ones the agent may touch.
          </p>
          {canManage && (
            <button
              onClick={() => setDialog("import")}
              className="mt-3 appearance-none border-none rounded-[3px] bg-mariner px-4 py-2 font-body text-[13px] font-semibold text-white cursor-pointer"
            >
              Import repositories
            </button>
          )}
        </div>
      )}

      {available && rows.length > 0 && (
        <ul className="list-none m-0 p-0 flex flex-col gap-2">
          {rows.map((repository) => {
            const summary = firstLine(repository.description);
            return (
              <li
                key={repository.id}
                className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <a
                      href={`/repositories/${repository.id}`}
                      className="font-display text-[15px] font-medium text-coal no-underline hover:underline"
                    >
                      {repository.displayName || repository.path}
                    </a>
                    <div className="mt-[2px] flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] text-neutral-700">
                        {repository.provider}:{repository.path}
                      </span>
                      <span className="rounded-[3px] bg-app-bg px-[5px] py-[1px] font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-600">
                        {sourceLabel(repository.source)}
                      </span>
                    </div>
                    {summary && (
                      <p className="m-0 mt-1 font-body text-[12px] text-neutral-600">
                        {summary}
                      </p>
                    )}
                    <div className="mt-1 font-body text-[11px] text-neutral-500">
                      {checksLabel(repository)} ·{" "}
                      {repository.profileVersion === 0
                        ? "never configured"
                        : `profile v${repository.profileVersion}, changed ${formatDateTime(
                            repository.updatedAt,
                          )}`}
                    </div>
                  </div>
                  <EnabledSwitch
                    repository={repository}
                    canManage={canManage}
                    onChanged={replaceRow}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
