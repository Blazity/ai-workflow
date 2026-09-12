"use client";

import { useEffect, useState } from "react";

import type {
  RepositoriesResponse,
  RepositoryCatalogActivateConflict,
  RepositoryCatalogActivateResponse,
  RepositoryCatalogClaimedRepository,
  RepositoryCatalogEntry,
  RepositoryCatalogState,
  RepositoryOption,
} from "@shared/contracts";

import { apiClient } from "@/lib/api/client";
import {
  ACTIVATION_REASON_MISSING,
  ACTIVATION_REASON_NOTE,
  acknowledgedKeys,
  activationBlocker,
  activationImpact,
  activationSummary,
  claimedDetail,
  claimedSummary,
  staleActivationNotice,
  uncataloguedSummary,
} from "@/lib/repository-catalog/activation";

/**
 * Ending the bridge.
 *
 * The population that stops passing is two populations, and both are on screen
 * before anything is sent: the catalog rows this catalog does not enable, and
 * everything the installation exposes that the catalog never held. After
 * activation the worker selects enabled rows and nothing else, so the second
 * group stops just as hard as the first, and it is the group an empty catalog
 * consists entirely of. The provider directory is read when the dialog opens to
 * find it.
 *
 * The population with work in flight can only come from the worker, and it
 * comes from the activate route itself: the first request acknowledges nothing,
 * and its 409 carries exactly the repositories the worker is about to act on.
 * That answer is rendered and the admin confirms a second time against it.
 *
 * Nothing is sent until the admin has typed a reason and clicked, so opening
 * this dialog never activates anything. That matters more than saving a round
 * trip: a catalog with no claimed repositories would otherwise be activated by
 * the act of looking at the dialog that exists to warn about it.
 */
export function ActivateDialog({
  repositories,
  onClose,
  onActivated,
}: {
  repositories: readonly RepositoryCatalogEntry[];
  onClose: () => void;
  onActivated: (state: RepositoryCatalogState) => void;
}) {
  const [claimed, setClaimed] = useState<RepositoryCatalogClaimedRepository[] | null>(
    null,
  );
  const [stale, setStale] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "reading" is not "refused" and neither is an empty list, which would be a
  // claim nobody checked. Three states, so three states.
  const [directory, setDirectory] = useState<
    { kind: "reading" } | { kind: "failed" } | { kind: "read"; rows: RepositoryOption[] }
  >({ kind: "reading" });

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const result = await apiClient.repositories.list({ cache: "no-store" });
        if (!live) return;
        const body = result.ok ? (result.data as Partial<RepositoriesResponse>) : null;
        setDirectory(
          Array.isArray(body?.repositories)
            ? { kind: "read", rows: body.repositories }
            : { kind: "failed" },
        );
      } catch {
        if (live) setDirectory({ kind: "failed" });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const impact = activationImpact({
    repositories,
    claimed: claimed ?? [],
    directory: directory.kind === "read" ? directory.rows : null,
  });
  const refusal = activationBlocker(impact);
  // The headline count is built from the directory as well as the catalog, so
  // confirming before the directory lands would be confirming against a number
  // that is about to change. A directory that FAILED is a different case: the
  // summary says the count is not known, and waiting for a read that will not
  // arrive would make activation impossible rather than careful.
  const blocker =
    refusal ??
    (directory.kind === "reading"
      ? "the provider directory is still being read"
      : reason.trim().length === 0
        ? ACTIVATION_REASON_MISSING
        : null);

  async function confirm() {
    setBusy(true);
    setError(null);
    setStale(false);
    try {
      const result = await apiClient.repositoryCatalog.activate(acknowledgedKeys(impact));
      if (result.ok && result.status === 409) {
        // Either the first click (nothing acknowledged yet) or a list that
        // moved while the dialog was open. Both render the same way: this is
        // what the worker is about to act on, confirm against it.
        const conflict = result.data as RepositoryCatalogActivateConflict;
        setStale(claimed !== null);
        setClaimed(conflict.repositories);
        return;
      }
      if (!result.ok) {
        setError(result.errorMessage);
        return;
      }
      onActivated((result.data as RepositoryCatalogActivateResponse).state);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const confirmLabel = busy
    ? "Activating…"
    : claimed === null
      ? "Activate"
      : "Activate anyway";

  return (
    <section
      role="dialog"
      aria-label="Activate the repository catalog"
      className="rounded-[4px] border border-orange-300 bg-panel px-4 py-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="m-0 font-display text-[15px] font-medium text-coal">
          Activate the repository catalog
        </h3>
        <button
          onClick={onClose}
          className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
        >
          Close
        </button>
      </div>

      <p className="m-0 mt-2 font-body text-[12px] text-neutral-700">
        {activationSummary(impact)}
      </p>

      <p className="m-0 mt-1 font-body text-[12px] text-neutral-700">
        {directory.kind === "reading"
          ? "Reading the provider directory to find the repositories outside this catalog…"
          : uncataloguedSummary(impact)}
      </p>

      {refusal !== null && (
        <div
          role="status"
          className="mt-2 rounded-[3px] border border-red-300 bg-red-50 px-2 py-[6px] font-body text-[12px] text-red-700"
        >
          Activation is refused: {refusal}.
        </div>
      )}

      {impact.stopping.length > 0 && (
        <details className="mt-2">
          <summary className="font-body text-[12px] text-mariner cursor-pointer">
            Repositories that stop passing ({impact.stopping.length})
          </summary>
          <ul className="list-none m-0 mt-1 p-0 flex flex-col gap-[2px]">
            {impact.stopping.map((repository) => (
              <li
                key={`${repository.provider}:${repository.path}`}
                className="font-mono text-[11px] text-neutral-700"
              >
                {repository.provider}:{repository.path}
              </li>
            ))}
          </ul>
        </details>
      )}

      {claimed !== null && (
        <>
          <p className="m-0 mt-2 font-body text-[12px] text-neutral-700">
            {claimedSummary(impact)}
          </p>
          <ul className="list-none m-0 mt-2 p-0 flex flex-col gap-1">
            {impact.claimed.map((entry) => (
              <li
                key={entry.key}
                className="rounded-[3px] border border-orange-300 bg-orange-100 px-2 py-[6px]"
              >
                <div className="font-mono text-[11px] text-[#A23E18]">{entry.key}</div>
                <div className="font-body text-[11px] text-neutral-700">
                  {claimedDetail(entry)}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {stale && (
        <div
          role="status"
          className="mt-2 rounded-[3px] border border-red-300 bg-red-50 px-2 py-[6px] font-body text-[12px] text-red-700"
        >
          {staleActivationNotice(impact.claimed)}
        </div>
      )}

      <label className="mt-3 block font-body text-[12px] text-neutral-800">
        Reason
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why the bridge is ending"
          className="mt-1 w-full rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-body text-[12px]"
        />
      </label>
      <p className="m-0 mt-1 font-body text-[10px] text-neutral-500">
        {ACTIVATION_REASON_NOTE}
      </p>

      {error && (
        <div className="mt-2 rounded-[3px] border border-red-300 bg-red-50 px-2 py-[6px] font-body text-[12px] text-red-700">
          {error}
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={confirm}
          disabled={blocker !== null || busy}
          className="appearance-none border-none rounded-[3px] bg-mariner px-4 py-2 font-body text-[13px] font-semibold text-white cursor-pointer disabled:opacity-40 disabled:cursor-default"
        >
          {confirmLabel}
        </button>
        {blocker !== null && refusal === null && (
          <span role="status" className="font-body text-[11px] text-red-600">
            Activate is disabled: {blocker}.
          </span>
        )}
      </div>
    </section>
  );
}
