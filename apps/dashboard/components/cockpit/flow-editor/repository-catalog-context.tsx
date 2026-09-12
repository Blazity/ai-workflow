"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import type {
  RepositoriesResponse,
  RepositoryCatalogEntry,
  RepositoryCatalogListResponse,
  RepositoryOption,
  RepositoryProviderStatus,
} from "@shared/contracts";
import { repositoryCatalogKey } from "@shared/contracts";
import { apiClient } from "@/lib/api/client";
import {
  repositoryKey,
  type PinnedRepository,
} from "@/lib/workflow-editor/repository-scope";

export type RepositoryCatalogStatus = "loading" | "ready" | "error";

/**
 * One row the repository picker can offer.
 *
 * `RepositoryOption` is the provider directory's shape and the editor's
 * consumers already read it, so the catalog's authority arrives as one extra
 * field rather than a second type nobody's props accept.
 */
export interface RepositoryPickerOption extends RepositoryOption {
  /**
   * Whether dispatch would accept an event from this repository.
   *
   * Absent and true both mean yes, because that is what the bridge means: while
   * the catalog is not activated every repository the installation can see is
   * enabled. Only an explicit `false` is a claim, and it says this row stops
   * passing the moment somebody activates the catalog.
   */
  enabledInCatalog?: boolean;
}

/** What the picker says when the provider directory did not answer and the
 *  providers had to be guessed from catalog rows. */
export const DIRECTORY_UNAVAILABLE_NOTE =
  "Provider directory unavailable, connection state unknown";

/** What it says when the catalog did not answer and the directory alone is
 *  driving the list. */
export const CATALOG_UNAVAILABLE_NOTE =
  "Repository catalog unavailable, enabled state unknown";

export interface RepositoryCatalogState {
  status: RepositoryCatalogStatus;
  /** Whether the catalog decides access. While it is false the bridge is on and
   *  the picker offers everything the installation can see. */
  activated: boolean;
  repositories: RepositoryPickerOption[];
  providers: RepositoryProviderStatus[];
  /** False when the provider directory did not answer. The rows and the
   *  providers are then the catalog's own, so `archived`, `private` and every
   *  provider's connection state are NOT known: a screen that rendered them as
   *  facts would report "ready" for a provider nobody could reach. */
  directoryAvailable: boolean;
  /** False when the catalog did not answer and the directory alone is driving
   *  the list, so `enabledInCatalog` is unknown on every row. The picker still
   *  works, because dispatch enforces the catalog whatever this screen shows. */
  catalogAvailable: boolean;
  refresh: () => void;
}

const noop = () => {};
const RepositoryCatalogContext = createContext<RepositoryCatalogState>({
  status: "loading",
  activated: false,
  repositories: [],
  providers: [],
  directoryAvailable: true,
  catalogAvailable: true,
  refresh: noop,
});

/** The catalog row as a picker row. The provider directory knows things the
 *  catalog does not (archived, private, the owner and name split), so a
 *  directory row for the same key is merged over this when there is one. */
function optionFromCatalog(entry: RepositoryCatalogEntry): RepositoryPickerOption {
  const slash = entry.path.lastIndexOf("/");
  return {
    provider: entry.provider,
    repoPath: entry.path,
    owner: slash === -1 ? "" : entry.path.slice(0, slash),
    name: slash === -1 ? entry.path : entry.path.slice(slash + 1),
    defaultBranch: entry.defaultBranch ?? "",
    private: false,
    archived: false,
    enabledInCatalog: entry.enabled,
  };
}

/**
 * The rows the picker offers, and what each of them means.
 *
 * Activated: the catalog is the grant, so only the rows it enables can be
 * pinned and only those are offered. A repository the provider directory can
 * see and the catalog does not enable is not a row somebody should be able to
 * pick by accident.
 *
 * Bridge: dispatch still accepts everything the installation can see, so the
 * directory is the list. A row the catalog carries and does not enable is
 * offered and MARKED, because it is exactly the pin that will stop working on
 * the day the catalog is activated.
 */
function pickerRepositories(input: {
  activated: boolean;
  catalog: readonly RepositoryCatalogEntry[];
  directory: readonly RepositoryOption[];
}): RepositoryPickerOption[] {
  const directoryByKey = new Map(
    input.directory.map((option) => [
      repositoryCatalogKey({ provider: option.provider, path: option.repoPath }),
      option,
    ]),
  );
  if (input.activated) {
    const rows: RepositoryPickerOption[] = [];
    for (const entry of input.catalog) {
      if (!entry.enabled) continue;
      const known = directoryByKey.get(repositoryCatalogKey(entry));
      const row = optionFromCatalog(entry);
      if (known === undefined) {
        rows.push(row);
        continue;
      }
      // The directory wins on what only it knows, and the catalog keeps the
      // default branch when the directory has none.
      rows.push({
        ...row,
        ...known,
        defaultBranch: known.defaultBranch || row.defaultBranch,
        enabledInCatalog: true,
      });
    }
    return rows;
  }
  const catalogByKey = new Map(
    input.catalog.map((entry) => [repositoryCatalogKey(entry), entry] as const),
  );
  const rows: RepositoryPickerOption[] = [];
  for (const option of input.directory) {
    const entry = catalogByKey.get(
      repositoryCatalogKey({ provider: option.provider, path: option.repoPath }),
    );
    rows.push({ ...option, enabledInCatalog: entry === undefined || entry.enabled });
  }
  return rows;
}

/**
 * Providers, when the provider directory did not answer.
 *
 * The catalog rows name which providers exist and nothing else: whether the
 * token still works, whether the installation is reachable, whether a provider
 * was disconnected an hour ago are all unknown. Stamping `ready` here is what
 * silenced the scope bar's "provider not connected" badge for exactly the
 * deployment whose provider had gone away, so the degraded state is reported as
 * an error carrying its own explanation instead.
 */
function providersFromRows(
  rows: readonly RepositoryPickerOption[],
): RepositoryProviderStatus[] {
  return [...new Set(rows.map((row) => row.provider))].map((provider) => ({
    provider,
    status: "error" as const,
    error: DIRECTORY_UNAVAILABLE_NOTE,
  }));
}

export function RepositoryCatalogProvider({
  children,
  initial,
}: {
  children: React.ReactNode;
  initial?: {
    status: RepositoryCatalogStatus;
    repositories: RepositoryPickerOption[];
    providers?: RepositoryProviderStatus[];
    activated?: boolean;
  };
}) {
  const [status, setStatus] = useState<RepositoryCatalogStatus>(
    initial?.status ?? "loading",
  );
  const [activated, setActivated] = useState<boolean>(initial?.activated ?? false);
  const [repositories, setRepositories] = useState<RepositoryPickerOption[]>(
    initial?.repositories ?? [],
  );
  const [providers, setProviders] = useState<RepositoryProviderStatus[]>(
    initial?.providers ?? providersFromRows(initial?.repositories ?? []),
  );
  const [directoryAvailable, setDirectoryAvailable] = useState(true);
  const [catalogAvailable, setCatalogAvailable] = useState(true);
  const listRequestId = useRef(0);

  const refresh = useCallback(() => {
    const id = ++listRequestId.current;
    setStatus("loading");
    void (async () => {
      // The catalog is the authority and the directory is the fleet the
      // installation can see; both are read at once because the bridge case
      // needs the directory and the activated case only enriches from it.
      const [catalogResponse, directoryResponse] = await Promise.all([
        apiClient.repositoryCatalog.list({ cache: "no-store" }).catch(() => null),
        apiClient.repositories.list({ cache: "no-store" }).catch(() => null),
      ]);
      if (id !== listRequestId.current) return;

      const rawCatalog =
        catalogResponse?.ok === true
          ? (catalogResponse.data as Partial<RepositoryCatalogListResponse> | null)
          : null;
      // A 200 carrying an unexpected body is as unusable as a bad status: every
      // consumer maps over `repositories`, so anything but an array counts as
      // the catalog not answering rather than landing as a `ready` catalog that
      // throws on render.
      const catalogBody =
        rawCatalog !== null &&
        Array.isArray(rawCatalog.repositories) &&
        typeof rawCatalog.state?.activated === "boolean"
          ? (rawCatalog as RepositoryCatalogListResponse)
          : null;

      const directoryBody =
        directoryResponse?.ok === true
          ? (directoryResponse.data as Partial<RepositoriesResponse> | null)
          : null;
      const directory = Array.isArray(directoryBody?.repositories)
        ? directoryBody.repositories
        : null;
      const directoryProviders = Array.isArray(directoryBody?.providers)
        ? directoryBody.providers
        : null;

      // Losing both is losing the picker outright, and so is losing the
      // directory while the bridge is on: under the bridge the directory IS the
      // list, so an empty one presented as ready reads as "no access".
      if (
        directory === null &&
        (catalogBody === null || !catalogBody.state.activated)
      ) {
        setStatus("error");
        return;
      }

      if (catalogBody === null) {
        // The directory alone, which is more use than a picker that will not
        // open: dispatch enforces the catalog whatever this screen believes, so
        // the risk of offering a row the catalog would refuse is a pin that
        // selects nothing, not a repository the agent reaches. Every row's
        // `enabledInCatalog` is left absent, which already means "not a claim",
        // and the notice says so out loud.
        setActivated(false);
        setRepositories(directory === null ? [] : [...directory]);
        setProviders(directoryProviders ?? []);
        setCatalogAvailable(false);
        setDirectoryAvailable(true);
        setStatus("ready");
        return;
      }

      const rows = pickerRepositories({
        activated: catalogBody.state.activated,
        catalog: catalogBody.repositories,
        directory: directory ?? [],
      });
      setActivated(catalogBody.state.activated);
      setRepositories(rows);
      setProviders(directoryProviders ?? providersFromRows(rows));
      setCatalogAvailable(true);
      setDirectoryAvailable(directory !== null);
      setStatus("ready");
    })();
  }, []);

  useEffect(() => {
    if (!initial) refresh();
  }, [initial, refresh]);

  return (
    <RepositoryCatalogContext.Provider
      value={{
        status,
        activated,
        repositories,
        providers,
        directoryAvailable,
        catalogAvailable,
        refresh,
      }}
    >
      {children}
    </RepositoryCatalogContext.Provider>
  );
}

export function useRepositoryCatalog(): RepositoryCatalogState {
  return useContext(RepositoryCatalogContext);
}

/**
 * The two ways a pin can be wrong, split once for every surface that says so.
 *
 * Activated, the catalog IS the list, so a pin that is not on it is a pin the
 * catalog does not enable, which is the finding the publish reports. While the
 * bridge is on the list is the whole directory, so the same absence means the
 * repository cannot be seen at all, and a row the catalog carries and does not
 * enable is the one to name instead.
 *
 * The scope bar, the picker modal and the deploy warning all read this rather
 * than each deriving it: three surfaces describing one fact three ways is how
 * an operator learns to believe the mildest one.
 */
export function splitPins(
  catalog: Pick<RepositoryCatalogState, "status" | "activated" | "repositories">,
  pinned: readonly PinnedRepository[],
): { unknown: PinnedRepository[]; notEnabled: PinnedRepository[] } {
  if (catalog.status !== "ready") return { unknown: [], notEnabled: [] };
  const byKey = new Map(
    catalog.repositories.map((option) => [repositoryKey(option), option]),
  );
  const absent: PinnedRepository[] = [];
  const refused: PinnedRepository[] = [];
  for (const repository of pinned) {
    const option = byKey.get(repositoryKey(repository));
    if (option === undefined) absent.push(repository);
    else if (option.enabledInCatalog === false) refused.push(repository);
  }
  return catalog.activated
    ? { unknown: [], notEnabled: absent }
    : { unknown: absent, notEnabled: refused };
}
