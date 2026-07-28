"use client";

import { useEffect, useId, useMemo, useState } from "react";

import type {
  RepositoryOption,
  VcsProviderKind,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import { Listbox } from "@/components/cockpit/listbox";
import {
  addPinnedRepositories,
  contradictingPinnedRepositories,
  isRepositoryPinned,
  MAX_PINNED_REPOSITORIES,
  normalizeRepositoryScope,
  PINNABLE_PROVIDERS,
  pinnedRepositories,
  providerLabel,
  removePinnedRepository,
  repositoryKey,
} from "@/lib/workflow-editor/repository-scope";
import { useRepositoryCatalog } from "./repository-catalog-context";

const CATALOG_CACHE_NOTE =
  "The repository catalog is cached for 60 seconds, so access granted a moment ago can still be missing here.";

interface CatalogEntry {
  option: RepositoryOption;
  disabledReason: string | null;
}

export interface RepositoryScopeModalProps {
  open: boolean;
  scope: WorkflowRepositoryScope;
  canEdit: boolean;
  onApply: (scope: WorkflowRepositoryScope) => void;
  onCancel: () => void;
}

export function RepositoryScopeModal({
  open,
  scope,
  canEdit,
  onApply,
  onCancel,
}: RepositoryScopeModalProps) {
  const catalog = useRepositoryCatalog();
  const titleId = useId();
  const providersId = useId();
  const repositoriesId = useId();
  const [draft, setDraft] = useState<WorkflowRepositoryScope>(() =>
    structuredClone(scope),
  );
  const [filter, setFilter] = useState("");
  const [manualProvider, setManualProvider] =
    useState<VcsProviderKind>("github");
  const [manualPath, setManualPath] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraft(structuredClone(scope));
    setFilter("");
    setManualPath("");
  }, [open, scope]);

  const catalogByKey = useMemo(
    () =>
      new Map(
        catalog.repositories.map((option) => [repositoryKey(option), option]),
      ),
    [catalog.repositories],
  );
  const providerStatusByKind = useMemo(
    () =>
      new Map(
        catalog.providers.map((provider) => [provider.provider, provider]),
      ),
    [catalog.providers],
  );
  const configuredProviders = PINNABLE_PROVIDERS.filter(
    (provider) => providerStatusByKind.get(provider)?.status !== "not_connected" &&
      providerStatusByKind.has(provider),
  );
  const explicitProviders = draft.providers ?? [];
  const activeProviders =
    explicitProviders.length > 0
      ? configuredProviders.filter((provider) =>
          explicitProviders.includes(provider),
        )
      : configuredProviders;
  const activeProviderSet = new Set(activeProviders);
  const manualProviders =
    configuredProviders.length > 0
      ? configuredProviders
      : catalog.status === "error"
        ? [...PINNABLE_PROVIDERS]
        : [];

  useEffect(() => {
    if (!open || manualProviders.includes(manualProvider)) return;
    const first = manualProviders[0];
    if (first) setManualProvider(first);
  }, [catalog.providers, catalog.status, manualProvider, open]);

  useEffect(() => {
    if (!open || catalog.status !== "ready") return;
    setDraft((current) => {
      const currentRepositories = pinnedRepositories(current);
      const kept = currentRepositories.filter(
        (repository) =>
          isRepositoryPinned(scope, repository) ||
          catalogByKey.has(repositoryKey(repository)),
      );
      if (kept.length === currentRepositories.length) return current;
      return normalizeRepositoryScope({ ...current, repositories: kept });
    });
  }, [catalog.status, catalogByKey, open, scope]);

  if (!open) return null;
  const pinned = pinnedRepositories(draft);
  const remaining = MAX_PINNED_REPOSITORIES - pinned.length;
  const catalogSettled = catalog.status === "ready";
  const unknownPins = catalogSettled
    ? pinned.filter((repository) => !catalogByKey.has(repositoryKey(repository)))
    : [];
  const archivedPins = pinned.filter(
    (repository) =>
      catalogByKey.get(repositoryKey(repository))?.archived === true,
  );
  const contradictingPins = contradictingPinnedRepositories(draft);
  const query = filter.trim().toLowerCase();
  const visibleRepositories = catalog.repositories.filter((option) =>
    activeProviderSet.has(option.provider),
  );
  const entries: CatalogEntry[] = visibleRepositories
    .filter((option) => option.repoPath.toLowerCase().includes(query))
    .map((option) => {
      const selected = isRepositoryPinned(draft, option);
      return {
        option,
        disabledReason:
          option.archived && !selected
            ? "Archived in the provider"
            : remaining <= 0 && !selected
              ? `Limit of ${MAX_PINNED_REPOSITORIES} reached`
              : null,
      };
    });
  const catalogEmpty =
    catalog.status === "ready" && visibleRepositories.length === 0;
  const manualRepoPath = manualPath.trim();
  const manualAlreadyPinned =
    manualRepoPath !== "" &&
    isRepositoryPinned(draft, {
      provider: manualProvider,
      repoPath: manualRepoPath,
    });
  const manualAddable =
    canEdit &&
    manualProviders.includes(manualProvider) &&
    manualRepoPath !== "" &&
    remaining > 0 &&
    !manualAlreadyPinned;

  function toggleRepository(option: RepositoryOption, checked: boolean) {
    setDraft((current) =>
      checked
        ? addPinnedRepositories(current, [
            { provider: option.provider, repoPath: option.repoPath },
          ])
        : removePinnedRepository(current, option),
    );
  }

  function toggleProvider(provider: VcsProviderKind) {
    if (!canEdit || !configuredProviders.includes(provider)) return;
    const active = activeProviderSet.has(provider);
    if (active && activeProviders.length === 1) return;
    setDraft((current) => {
      const currentActive =
        (current.providers?.length ?? 0) > 0
          ? configuredProviders.filter((candidate) =>
              current.providers!.includes(candidate),
            )
          : configuredProviders;
      const nextProviders = active
        ? currentActive.filter((candidate) => candidate !== provider)
        : PINNABLE_PROVIDERS.filter(
            (candidate) =>
              configuredProviders.includes(candidate) &&
              [...currentActive, provider].includes(candidate),
          );
      const repositories = active
        ? pinnedRepositories(current).filter(
            (repository) => repository.provider !== provider,
          )
        : pinnedRepositories(current);
      const allConfiguredActive =
        nextProviders.length === configuredProviders.length;
      return normalizeRepositoryScope({
        repositories: [...repositories],
        ...(allConfiguredActive ? {} : { providers: nextProviders }),
      });
    });
  }

  function addManualRepository() {
    if (!manualAddable) return;
    setDraft((current) =>
      addPinnedRepositories(current, [
        { provider: manualProvider, repoPath: manualRepoPath },
      ]),
    );
    setManualPath("");
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-coal/30 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!event.shiftKey && event.target === last) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && event.target === first) {
          event.preventDefault();
          last.focus();
        }
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-32px)] w-full max-w-[680px] flex-col overflow-hidden rounded-[6px] bg-panel shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-neutral-200 px-5 py-4">
          <div>
            <h2
              id={titleId}
              className="font-mono text-[13px] font-semibold uppercase tracking-[0.04em] text-coal"
            >
              Configure source scope
            </h2>
            <p className="mt-1 font-body text-[11px] text-neutral-500">
              Choose which providers and repositories every ticket can use.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close source scope"
            onClick={onCancel}
            className="inline-flex size-10 items-center justify-center rounded-[4px] border border-transparent bg-transparent font-mono text-[18px] text-neutral-500 hover:bg-app-bg hover:text-coal focus-visible:outline-2 focus-visible:outline-mariner"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <section aria-labelledby={providersId}>
            <h3
              id={providersId}
              className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-neutral-700"
            >
              Providers
            </h3>
            <p className="mt-1 font-body text-[11px] text-neutral-500">
              Connected providers are active by default. Turn one off to narrow
              the repository list and workflow scope.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {PINNABLE_PROVIDERS.map((provider) => {
                const providerStatus = providerStatusByKind.get(provider);
                const connected =
                  providerStatus !== undefined &&
                  providerStatus.status !== "not_connected";
                const active = activeProviderSet.has(provider);
                const lastActive = active && activeProviders.length === 1;
                return (
                  <button
                    key={provider}
                    type="button"
                    autoFocus={provider === PINNABLE_PROVIDERS[0]}
                    aria-pressed={active}
                    disabled={!canEdit || !connected || lastActive}
                    title={
                      !connected
                        ? `${providerLabel(provider)} is not connected`
                        : lastActive
                          ? "At least one provider must stay active"
                          : undefined
                    }
                    onClick={() => toggleProvider(provider)}
                    className={`inline-flex h-11 w-[164px] items-center justify-between gap-3 rounded-[4px] border px-3 font-mono text-[11px] font-semibold transition-transform active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-mariner motion-reduce:transform-none disabled:cursor-default disabled:opacity-50 ${
                      active
                        ? "border-mariner bg-mariner-100 text-mariner"
                        : "border-neutral-300 bg-panel text-neutral-600 hover:bg-app-bg"
                    }`}
                  >
                    <span>{providerLabel(provider)}</span>
                    <span
                      className={`font-body text-[9px] font-medium ${
                        connected
                          ? active
                            ? "text-mariner"
                            : "text-neutral-500"
                          : "text-neutral-400"
                      }`}
                    >
                      {connected
                        ? providerStatus.status === "error"
                          ? "Connection error"
                          : active
                            ? "Active"
                            : "Off"
                        : "Not connected"}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          <section aria-labelledby={repositoriesId} className="mt-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3
                  id={repositoriesId}
                  className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-neutral-700"
                >
                  Repositories
                </h3>
                <p className="mt-1 font-body text-[11px] text-neutral-500">
                  Pin up to {MAX_PINNED_REPOSITORIES} repositories for every
                  ticket, or leave this empty for automatic selection.
                </p>
              </div>
              <button
                type="button"
                onClick={catalog.refresh}
                className="inline-flex h-10 shrink-0 items-center justify-center rounded-[4px] px-2 font-body text-[11px] font-semibold text-mariner focus-visible:outline-2 focus-visible:outline-mariner"
              >
                Refresh catalog
              </button>
            </div>

            {pinned.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2" aria-label="Selected repositories">
                {pinned.map((repository) => (
                  <span
                    key={repositoryKey(repository)}
                    className="inline-flex h-8 items-center rounded-[4px] border border-neutral-200 bg-app-bg pl-2 font-mono text-[10px] text-neutral-800"
                  >
                    <span>{repository.repoPath}</span>
                    <span className="ml-2 border-l border-neutral-200 px-2 text-[9px] uppercase text-neutral-500">
                      {providerLabel(repository.provider)}
                    </span>
                    <button
                      type="button"
                      disabled={!canEdit}
                      aria-label={`Remove ${repository.repoPath}`}
                      onClick={() =>
                        setDraft((current) =>
                          removePinnedRepository(current, repository),
                        )
                      }
                      className="inline-flex size-10 items-center justify-center rounded-r-[4px] text-[16px] text-neutral-500 hover:bg-white hover:text-coal focus-visible:outline-2 focus-visible:outline-mariner disabled:cursor-default disabled:opacity-40"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            {contradictingPins.length > 0 && (
              <div
                role="status"
                className="mt-3 rounded-[4px] border border-amber-300 bg-amber-50 px-3 py-2 font-body text-[11px] text-amber-800"
              >
                Provider mismatch:{" "}
                {contradictingPins
                  .map(
                    (repository) =>
                      `${repository.repoPath} (${providerLabel(repository.provider)})`,
                  )
                  .join(", ")}{" "}
                {contradictingPins.length === 1 ? "is" : "are"} excluded by the
                selected providers. Deployment rejects this until the two agree.
              </div>
            )}

            {unknownPins.length > 0 && (
              <div
                role="status"
                className="mt-3 rounded-[4px] border border-amber-300 bg-amber-50 px-3 py-2 font-body text-[11px] text-amber-800"
              >
                The catalog does not list{" "}
                {unknownPins.map((repository) => repository.repoPath).join(", ")}.
                The pin is kept exactly as saved. Access may have been revoked,
                or the catalog may be stale. {CATALOG_CACHE_NOTE}
              </div>
            )}

            {archivedPins.length > 0 && (
              <div
                role="status"
                className="mt-3 rounded-[4px] border border-amber-300 bg-amber-50 px-3 py-2 font-body text-[11px] text-amber-800"
              >
                Archived in the provider:{" "}
                {archivedPins.map((repository) => repository.repoPath).join(", ")}.
                The pin is kept, but the workflow cannot open changes there.
              </div>
            )}

            {catalog.status === "loading" && (
              <div className="mt-3 rounded-[4px] bg-app-bg px-3 py-6 text-center font-body text-[11px] text-neutral-500">
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
                  className="mt-3 h-10 w-full rounded-[4px] border border-neutral-200 bg-white px-3 font-mono text-[11px] text-coal outline-none focus:border-mariner focus-visible:outline-2 focus-visible:outline-mariner disabled:opacity-60"
                />
                <div className="mt-2 max-h-[260px] overflow-y-auto rounded-[4px] border border-neutral-200">
                  {entries.length === 0 ? (
                    <div className="px-3 py-8 text-center font-body text-[11px] text-neutral-500">
                      No repository in the catalog matches this filter.
                    </div>
                  ) : (
                    entries.map(({ option, disabledReason }) => {
                      const checked = isRepositoryPinned(draft, option);
                      return (
                        <label
                          key={repositoryKey(option)}
                          className={`flex min-h-11 items-center gap-3 border-b border-neutral-100 px-3 last:border-b-0 ${
                            disabledReason === null
                              ? "cursor-pointer bg-panel hover:bg-app-bg"
                              : "cursor-default bg-app-bg"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!canEdit || disabledReason !== null}
                            aria-label={`Pin ${option.repoPath}`}
                            onChange={(event) =>
                              toggleRepository(option, event.target.checked)
                            }
                            className="size-4 accent-mariner"
                          />
                          <span
                            className={`min-w-0 flex-1 truncate font-mono text-[11px] ${
                              disabledReason === null
                                ? "text-coal"
                                : "text-neutral-500"
                            }`}
                          >
                            {option.repoPath}
                          </span>
                          <span className="hidden h-6 items-center rounded-[3px] border border-neutral-200 bg-panel px-2 font-mono text-[9px] uppercase text-neutral-500 sm:inline-flex">
                            {providerLabel(option.provider)}
                          </span>
                          <span className="hidden font-mono text-[9px] text-neutral-500 md:inline">
                            {option.defaultBranch === ""
                              ? "no default branch"
                              : option.defaultBranch}
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
                <div className="mt-2 flex items-start justify-between gap-3 font-body text-[10px] text-neutral-500">
                  <span className="tabular-nums">
                    {remaining} of {MAX_PINNED_REPOSITORIES} slots left.
                  </span>
                  <span className="max-w-[420px] text-right">
                    {activeProviders.length === configuredProviders.length
                      ? CATALOG_CACHE_NOTE
                      : `Showing ${activeProviders.map(providerLabel).join(" + ")} repositories only.`}
                  </span>
                </div>
              </>
            )}

            {(catalog.status === "error" || catalogEmpty) && (
              <div className="mt-3 rounded-[4px] border border-neutral-200 bg-app-bg p-3">
                {catalog.status === "error" ? (
                  <div role="alert" className="font-body text-[11px] text-red-600">
                    The repository catalog is unavailable, so it cannot be
                    browsed. Saved pins are preserved. Enter an exact owner/repo
                    the workspace already has access to.
                  </div>
                ) : (
                  <div className="font-body text-[11px] text-neutral-600">
                    The catalog returned no repositories. Enter an exact
                    owner/repo if the workspace can reach one it does not list.
                  </div>
                )}
                <div className="mt-3 flex items-center gap-2">
                  <div className="w-[120px] shrink-0">
                    <Listbox
                      options={manualProviders.map((provider) => ({
                        value: provider,
                        label: providerLabel(provider),
                        hint:
                          provider === "github" ? "github.com" : "gitlab.com",
                      }))}
                      value={manualProvider}
                      disabled={!canEdit}
                      ariaLabel="Provider for the manually entered repository"
                      onChange={(value) =>
                        setManualProvider(value as VcsProviderKind)
                      }
                    />
                  </div>
                  <input
                    value={manualPath}
                    disabled={!canEdit}
                    onChange={(event) => setManualPath(event.target.value)}
                    placeholder="owner/repo"
                    aria-label="Repository path"
                    className="h-10 min-w-0 flex-1 rounded-[4px] border border-neutral-200 bg-white px-3 font-mono text-[11px] text-coal outline-none focus:border-mariner focus-visible:outline-2 focus-visible:outline-mariner disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={addManualRepository}
                    disabled={!manualAddable}
                    className="inline-flex h-10 shrink-0 items-center justify-center rounded-[4px] border border-neutral-300 bg-panel px-3 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-coal focus-visible:outline-2 focus-visible:outline-mariner disabled:cursor-default disabled:opacity-40"
                  >
                    Add to selection
                  </button>
                </div>
                {manualAlreadyPinned && (
                  <div className="pt-2 font-body text-[10px] text-amber-800">
                    {manualRepoPath} is already pinned for{" "}
                    {providerLabel(manualProvider)}.
                  </div>
                )}
                {manualRepoPath !== "" && remaining <= 0 && (
                  <div className="pt-2 font-body text-[10px] text-amber-800">
                    The pin already holds {MAX_PINNED_REPOSITORIES} repositories,
                    the workspace limit.
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-neutral-200 bg-app-bg px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-10 items-center justify-center rounded-[4px] border border-neutral-300 bg-panel px-4 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-coal transition-transform active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-mariner motion-reduce:transform-none"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => onApply(draft)}
            className="inline-flex h-10 items-center justify-center rounded-[4px] border border-mariner bg-mariner px-4 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-white transition-transform active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-mariner motion-reduce:transform-none disabled:cursor-default disabled:opacity-40"
          >
            Apply scope
          </button>
        </footer>
      </section>
    </div>
  );
}
