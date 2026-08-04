"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { WorkflowRepositoryScope } from "@shared/contracts";
import {
  contradictingPinnedRepositories,
  pinnedRepositories,
  providerLabel,
  repositoryKey,
  type PinnedRepository,
} from "@/lib/workflow-editor/repository-scope";
import { useRepositoryCatalog } from "./repository-catalog-context";
import { RepositoryScopeModal } from "./repository-scope-modal";

const attentionBadgeClass =
  "inline-flex h-6 shrink-0 items-center rounded-[3px] border px-2 font-mono text-[10px]";

function reason(
  label: string,
  repositories: readonly PinnedRepository[],
): string | null {
  if (repositories.length === 0) return null;
  return `${repositories.map((repository) => repository.repoPath).join(", ")}: ${label}`;
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
  const [modalOpen, setModalOpen] = useState(false);
  const configureRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const pinned = pinnedRepositories(scope);
  const catalogByKey = useMemo(
    () =>
      new Map(
        catalog.repositories.map((option) => [repositoryKey(option), option]),
      ),
    [catalog.repositories],
  );
  const unknownPins =
    catalog.status === "ready"
      ? pinned.filter(
          (repository) => !catalogByKey.has(repositoryKey(repository)),
        )
      : [];
  const archivedPins = pinned.filter(
    (repository) =>
      catalogByKey.get(repositoryKey(repository))?.archived === true,
  );
  const explicitProviders = scope.providers ?? [];
  const configuredProviders = catalog.providers
    .filter((provider) => provider.status !== "not_connected")
    .map((provider) => provider.provider);
  const displayedProviders =
    explicitProviders.length > 0 ? explicitProviders : configuredProviders;
  const disconnectedPins =
    catalog.status === "ready"
      ? pinned.filter(
          (repository) => !configuredProviders.includes(repository.provider),
        )
      : [];
  // A disconnected provider is why its repositories are missing from the catalog,
  // so those pins are named once, under the reason an operator can act on.
  const missingPins = unknownPins.filter(
    (repository) => !disconnectedPins.includes(repository),
  );
  // The badge stays a badge: the reasons ride along as its accessible label so an
  // operator learns which pin is broken without the bar growing a warning panel
  // that duplicates the modal.
  const attentionReasons = [
    reason("provider not connected", disconnectedPins),
    reason("not in catalog", missingPins),
    reason("archived", archivedPins),
    reason(
      "excluded by the pinned providers",
      contradictingPinnedRepositories(scope),
    ),
    catalog.status === "error" ? "Repository catalog could not be loaded" : null,
  ].filter((entry) => entry !== null);

  useEffect(() => {
    if (wasOpen.current && !modalOpen) configureRef.current?.focus();
    wasOpen.current = modalOpen;
  }, [modalOpen]);

  return (
    <>
      <div className="flex min-h-[52px] items-center gap-3 border-b border-neutral-200 bg-app-bg px-6 py-2">
        <div className="min-w-[110px] shrink-0">
          <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-neutral-700">
            Source scope
          </div>
          <div className="font-body text-[10px] text-neutral-500">
            Providers &amp; repositories
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
          <div className="flex min-w-0 items-center gap-2 truncate font-body text-[11px] text-neutral-700">
            <span className="shrink-0">
              <span className="text-neutral-500">Providers:</span>{" "}
              {displayedProviders.length === 0
                ? "No provider connected"
                : displayedProviders.map(providerLabel).join(" + ")}
            </span>
            <span aria-hidden="true" className="text-neutral-300">
              ·
            </span>
            <span className="min-w-0 truncate tabular-nums">
              <span className="text-neutral-500">Repositories:</span>{" "}
              {pinned.length === 0
                ? "Automatic per ticket"
                : `${pinned.length} pinned`}
            </span>
          </div>
          {attentionReasons.length > 0 && (
            <span
              role="status"
              title={attentionReasons.join("; ")}
              aria-label={`Needs attention: ${attentionReasons.join("; ")}`}
              className={`${attentionBadgeClass} border-amber-300 bg-amber-50 text-amber-800`}
            >
              Needs attention
            </span>
          )}
        </div>

        <button
          ref={configureRef}
          type="button"
          aria-haspopup="dialog"
          onClick={() => setModalOpen(true)}
          disabled={!canEdit}
          className="inline-flex h-10 shrink-0 items-center justify-center rounded-[4px] border border-neutral-300 bg-panel px-3 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-coal transition-transform hover:bg-white active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-mariner motion-reduce:transform-none disabled:cursor-default disabled:opacity-40"
        >
          Configure
        </button>
      </div>

      <RepositoryScopeModal
        open={modalOpen}
        scope={scope}
        canEdit={canEdit}
        onApply={(next) => {
          onChange(next);
          setModalOpen(false);
        }}
        onCancel={() => setModalOpen(false)}
      />
    </>
  );
}
