"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  RepositoryOption,
  VcsProviderKind,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import { Listbox } from "@/components/cockpit/listbox";
import {
  addPinnedRepositories,
  contradictingPinnedRepositories,
  describeRepositoryScope,
  effectiveScopeProviders,
  isRepositoryPinned,
  isRepositoryScopeEmpty,
  MAX_PINNED_REPOSITORIES,
  PINNABLE_PROVIDERS,
  pinnedRepositories,
  providerLabel,
  removePinnedRepository,
  repositoryKey,
  togglePinnedProvider,
  type PinnedRepository,
} from "@/lib/workflow-editor/repository-scope";
import { useRepositoryCatalog } from "./repository-catalog-context";

const CATALOG_CACHE_NOTE =
  "The repository catalog is cached for 60 seconds, so access granted a moment ago can still be missing here.";

/** Bordered so it reads both on the grey bar chips and on the white picker rows. */
const providerPillClass =
  "rounded-[3px] border border-neutral-200 bg-panel px-[5px] py-[1px] font-mono text-[10px] uppercase text-neutral-500";

function ProviderPill({ provider }: { provider: VcsProviderKind }) {
  return <span className={providerPillClass}>{provider}</span>;
}

function RepositoryChip({
  repository,
  defaultBranch,
  unknown,
  canEdit,
  onRemove,
}: {
  repository: PinnedRepository;
  defaultBranch: string | null;
  unknown: boolean;
  canEdit: boolean;
  onRemove: () => void;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 font-mono text-[10px] ${
        unknown
          ? "border-amber-300 bg-amber-50 text-amber-800"
          : "border-neutral-200 bg-app-bg text-neutral-800"
      }`}
    >
      {repository.repoPath}
      <ProviderPill provider={repository.provider} />
      {defaultBranch !== null && defaultBranch !== "" && (
        <span className="font-mono text-[9px] text-neutral-500">{defaultBranch}</span>
      )}
      {unknown && (
        <span className="font-mono text-[9px] uppercase text-amber-700">unverified</span>
      )}
      <button
        type="button"
        disabled={!canEdit}
        aria-label={`Remove ${repository.repoPath}`}
        onClick={onRemove}
        className="appearance-none border-none bg-transparent cursor-pointer text-neutral-500 hover:text-coal disabled:cursor-default disabled:opacity-40"
      >
        ×
      </button>
    </span>
  );
}

interface CatalogEntry {
  option: RepositoryOption;
  disabledReason: string | null;
}

export function RepositoryScopePicker({
  open,
  scope,
  canEdit,
  onAdd,
  onClose,
}: {
  open: boolean;
  scope: WorkflowRepositoryScope;
  canEdit: boolean;
  onAdd: (repositories: PinnedRepository[]) => void;
  onClose: () => void;
}) {
  const catalog = useRepositoryCatalog();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [manualProvider, setManualProvider] = useState<VcsProviderKind>("github");
  const [manualPath, setManualPath] = useState("");

  const remaining = MAX_PINNED_REPOSITORIES - pinnedRepositories(scope).length;
  const catalogByKey = useMemo(
    () =>
      new Map(
        catalog.repositories.map((option) => [repositoryKey(option), option]),
      ),
    [catalog.repositories],
  );
  const entries = useMemo<CatalogEntry[]>(() => {
    const query = filter.trim().toLowerCase();
    return catalog.repositories
      .filter((option) => option.repoPath.toLowerCase().includes(query))
      .map((option) => {
        const key = repositoryKey(option);
        const pinned = isRepositoryPinned(scope, option);
        const atLimit = !selected.includes(key) && selected.length >= remaining;
        return {
          option,
          disabledReason: pinned
            ? "Already pinned"
            : option.archived
              ? "Archived in the provider"
              : atLimit
                ? `Limit of ${MAX_PINNED_REPOSITORIES} reached`
                : null,
        };
      });
  }, [catalog.repositories, filter, remaining, scope, selected]);

  /** A 200 with an empty list is reachable, and it must not strand the operator. */
  const catalogEmpty =
    catalog.status === "ready" && catalog.repositories.length === 0;

  // Dismissing abandons the selection. The closed picker stays mounted, so
  // without this a reopen would show a stale count and add repositories the
  // operator picked in a session they already walked away from.
  useEffect(() => {
    if (open) return;
    setSelected([]);
    setFilter("");
  }, [open]);

  if (!open) return null;

  function commitSelected() {
    // Resolve against the whole catalog, never the filtered rows: `selected`
    // accumulates across filter changes, so filtering by `entries` would drop
    // everything picked under an earlier filter.
    const additions = selected
      .map((key) => catalogByKey.get(key))
      .filter((option): option is RepositoryOption => option !== undefined)
      .map((option) => ({
        provider: option.provider,
        repoPath: option.repoPath,
      }));
    if (additions.length === 0) return;
    onAdd(additions);
    setSelected([]);
    setFilter("");
    onClose();
  }

  function commitManual() {
    const repoPath = manualPath.trim();
    if (repoPath === "" || remaining <= 0) return;
    const repository = { provider: manualProvider, repoPath };
    if (isRepositoryPinned(scope, repository)) return;
    onAdd([repository]);
    setManualPath("");
    onClose();
  }

  return (
    <section
      aria-label="Add pinned repositories"
      className="rounded-[3px] border border-neutral-200 bg-panel px-3 py-2.5"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-neutral-700">
          Add repositories
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={catalog.refresh}
            className="appearance-none border-none bg-transparent p-0 font-body text-[10px] font-semibold text-mariner cursor-pointer"
          >
            Refresh catalog
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the repository picker"
            className="appearance-none border-none bg-transparent p-0 font-body text-[10px] text-neutral-500 cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>

      {catalog.status === "loading" && (
        <div className="pt-2 font-body text-[10px] text-neutral-500">
          Loading repositories…
        </div>
      )}

      {catalog.status === "ready" && !catalogEmpty && (
        <>
          <input
            value={filter}
            disabled={!canEdit}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter repositories…"
            aria-label="Filter repositories"
            className="mt-2 h-[28px] w-full rounded-[3px] border border-neutral-200 bg-white px-2 font-mono text-[11px] text-coal outline-none focus:border-mariner disabled:opacity-60"
          />
          <div className="mt-2 max-h-[220px] overflow-y-auto rounded-[3px] border border-neutral-200">
            {entries.length === 0 ? (
              <div className="px-2 py-6 text-center font-body text-[10px] text-neutral-500">
                No repository in the catalog matches this filter.
              </div>
            ) : (
              entries.map(({ option, disabledReason }) => {
                const key = repositoryKey(option);
                const checked = selected.includes(key);
                return (
                  <label
                    key={key}
                    className={`flex items-center gap-2 border-b border-neutral-100 px-2 py-1.5 last:border-b-0 ${
                      disabledReason === null
                        ? "cursor-pointer bg-panel"
                        : "cursor-default bg-app-bg"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!canEdit || disabledReason !== null}
                      aria-label={`Pin ${option.repoPath}`}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, key]
                            : current.filter((entry) => entry !== key),
                        )
                      }
                      className="size-3 accent-mariner"
                    />
                    <span
                      className={`min-w-0 flex-1 truncate font-mono text-[11px] ${
                        disabledReason === null ? "text-coal" : "text-neutral-500"
                      }`}
                    >
                      {option.repoPath}
                    </span>
                    <ProviderPill provider={option.provider} />
                    <span className="font-mono text-[9px] text-neutral-500">
                      {option.defaultBranch === "" ? "no default branch" : option.defaultBranch}
                    </span>
                    {disabledReason !== null && (
                      <span className="font-body text-[10px] text-neutral-500">
                        {disabledReason}
                      </span>
                    )}
                  </label>
                );
              })
            )}
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="font-body text-[10px] text-neutral-500">
              {remaining} of {MAX_PINNED_REPOSITORIES} slots left. {CATALOG_CACHE_NOTE}
            </span>
            <button
              type="button"
              onClick={commitSelected}
              disabled={!canEdit || selected.length === 0}
              className="appearance-none rounded-[3px] border border-mariner bg-mariner px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-white cursor-pointer disabled:cursor-default disabled:opacity-40"
            >
              {selected.length === 0
                ? "Add repositories"
                : `Add ${selected.length} ${
                    selected.length === 1 ? "repository" : "repositories"
                  }`}
            </button>
          </div>
        </>
      )}

      {(catalog.status === "error" || catalogEmpty) && (
        <div className="pt-2">
          {catalog.status === "error" ? (
            <div role="alert" className="font-body text-[10px] text-red-600">
              The repository catalog is unavailable, so it cannot be browsed. Enter an
              exact owner/repo the workspace already has access to.
            </div>
          ) : (
            <div className="font-body text-[10px] text-neutral-600">
              The catalog returned no repositories, so there is nothing to browse. If
              the workspace can reach one it does not list, enter its exact
              owner/repo.
            </div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <div className="w-[110px]">
              <Listbox
                options={PINNABLE_PROVIDERS.map((provider) => ({
                  value: provider,
                  label: providerLabel(provider),
                  hint: provider === "github" ? "github.com" : "gitlab",
                }))}
                value={manualProvider}
                disabled={!canEdit}
                ariaLabel="Provider for the manually entered repository"
                onChange={(value) => setManualProvider(value as VcsProviderKind)}
              />
            </div>
            <input
              value={manualPath}
              disabled={!canEdit}
              onChange={(event) => setManualPath(event.target.value)}
              placeholder="owner/repo"
              aria-label="Repository path"
              className="h-[28px] flex-1 rounded-[3px] border border-neutral-200 bg-white px-2 font-mono text-[11px] text-coal outline-none focus:border-mariner disabled:opacity-60"
            />
            <button
              type="button"
              onClick={commitManual}
              disabled={!canEdit || manualPath.trim() === "" || remaining <= 0}
              className="appearance-none rounded-[3px] border border-neutral-300 bg-panel px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-coal cursor-pointer disabled:cursor-default disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function RepositoryScopeBar({
  scope,
  canEdit,
  onChange,
}: {
  scope: WorkflowRepositoryScope;
  canEdit: boolean;
  onChange: (scope: WorkflowRepositoryScope) => void;
}) {
  const catalog = useRepositoryCatalog();
  const [pickerOpen, setPickerOpen] = useState(false);

  const pinned = pinnedRepositories(scope);
  const catalogByKey = useMemo(
    () =>
      new Map(
        catalog.repositories.map((option) => [repositoryKey(option), option]),
      ),
    [catalog.repositories],
  );
  /** Only a settled catalog can prove a pin is missing, so a pending one never warns. */
  const catalogSettled = catalog.status === "ready";
  const unknownPins = catalogSettled
    ? pinned.filter((repository) => !catalogByKey.has(repositoryKey(repository)))
    : [];
  const archivedPins = pinned.filter(
    (repository) => catalogByKey.get(repositoryKey(repository))?.archived === true,
  );
  const atLimit = pinned.length >= MAX_PINNED_REPOSITORIES;
  const providers = effectiveScopeProviders(scope);
  const contradictingPins = contradictingPinnedRepositories(scope);

  return (
    <div className="flex flex-col gap-2 px-6 py-2 border-b border-neutral-200 bg-app-bg">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-[110px]">
          <div className="font-mono text-[9px] font-semibold tracking-[0.06em] uppercase text-neutral-700">
            Repositories
          </div>
          <div className="font-body text-[10px] text-neutral-500">
            Pinned for every ticket
          </div>
        </div>
        {pinned.length === 0 ? (
          <span className="font-body text-[10px] text-neutral-500">
            {(scope.providers?.length ?? 0) === 0
              ? "No repository pinned: every ticket resolves its own, as it does today."
              : "No repository pinned: every ticket resolves its own within the pinned providers."}
          </span>
        ) : (
          pinned.map((repository) => {
            const option = catalogByKey.get(repositoryKey(repository));
            return (
              <RepositoryChip
                key={repositoryKey(repository)}
                repository={repository}
                defaultBranch={option?.defaultBranch ?? null}
                unknown={catalogSettled && option === undefined}
                canEdit={canEdit}
                onRemove={() => onChange(removePinnedRepository(scope, repository))}
              />
            );
          })
        )}
        <span
          title={`${MAX_PINNED_REPOSITORIES} pinned repositories is the workspace limit.`}
          className="font-mono text-[10px] text-neutral-600"
        >
          {pinned.length} / {MAX_PINNED_REPOSITORIES}
        </span>
        <button
          type="button"
          onClick={() => setPickerOpen((open) => !open)}
          disabled={!canEdit || atLimit}
          className="appearance-none rounded-[3px] border border-neutral-300 bg-panel px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.04em] text-coal cursor-pointer hover:bg-app-bg disabled:cursor-default disabled:opacity-40"
        >
          {pickerOpen ? "Done" : "+ Add repository"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-[110px]">
          <div className="font-mono text-[9px] font-semibold tracking-[0.06em] uppercase text-neutral-700">
            Providers
          </div>
          <div className="font-body text-[10px] text-neutral-500">
            Both makes a run multi-repo
          </div>
        </div>
        {PINNABLE_PROVIDERS.map((provider) => {
          const active = (scope.providers ?? []).includes(provider);
          return (
            <button
              key={provider}
              type="button"
              aria-pressed={active}
              disabled={!canEdit}
              onClick={() => onChange(togglePinnedProvider(scope, provider))}
              className={`appearance-none rounded-pill border px-2.5 py-0.5 font-mono text-[10px] cursor-pointer disabled:cursor-default disabled:opacity-40 ${
                active
                  ? "border-mariner bg-mariner-100 text-mariner"
                  : "border-neutral-200 bg-panel text-neutral-600"
              }`}
            >
              {providerLabel(provider)}
            </button>
          );
        })}
        {(scope.providers?.length ?? 0) === 0 && (
          <span className="font-body text-[10px] text-neutral-500">
            {pinned.length === 0
              ? "No provider pinned: the run picks the provider itself."
              : `Inherited from the pinned repositories: ${providers
                  .map(providerLabel)
                  .join(" + ")}.`}
          </span>
        )}
        {contradictingPins.length > 0 && (
          <span
            role="status"
            className="rounded-[3px] border border-amber-300 bg-amber-50 px-2 py-0.5 font-body text-[10px] text-amber-800"
          >
            Provider mismatch:{" "}
            {contradictingPins
              .map((r) => `${r.repoPath} (${providerLabel(r.provider)})`)
              .join(", ")}{" "}
            {contradictingPins.length === 1 ? "is" : "are"} pinned but excluded by
            the selected providers. Deployment rejects this until the two agree.
          </span>
        )}
      </div>

      {unknownPins.length > 0 && (
        <div
          role="status"
          className="rounded-[3px] border border-amber-300 bg-amber-50 px-2.5 py-1.5 font-body text-[10px] text-amber-800"
        >
          The catalog does not list {unknownPins.map((r) => r.repoPath).join(", ")}.
          The pin is kept exactly as saved. Access may have been revoked, the
          repository may sit outside the server allowlist, or the catalog may be
          stale. {CATALOG_CACHE_NOTE}
        </div>
      )}

      {archivedPins.length > 0 && (
        <div
          role="status"
          className="rounded-[3px] border border-amber-300 bg-amber-50 px-2.5 py-1.5 font-body text-[10px] text-amber-800"
        >
          Archived in the provider: {archivedPins.map((r) => r.repoPath).join(", ")}.
          The pin is kept, but the workflow cannot open changes there.
        </div>
      )}

      {catalog.status === "loading" && pinned.length > 0 && (
        <div className="font-body text-[10px] text-neutral-500">
          Checking the pinned repositories against the catalog…
        </div>
      )}

      {catalog.status === "error" && !pickerOpen && (
        <div role="status" className="font-body text-[10px] text-red-600">
          The repository catalog is unavailable. Saved pins are preserved, and new
          ones can be entered by exact path.
        </div>
      )}

      {!isRepositoryScopeEmpty(scope) && (
        <div className="font-body text-[10px] text-neutral-500">
          Every ticket entering this workflow inherits{" "}
          {describeRepositoryScope(scope)}. The run never asks which repository to
          use, and the pull request trigger filter follows this pin.
        </div>
      )}

      <RepositoryScopePicker
        open={pickerOpen}
        scope={scope}
        canEdit={canEdit}
        onAdd={(repositories) => onChange(addPinnedRepositories(scope, repositories))}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
