"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import type {
  RepositoriesResponse,
  RepositoryOption,
  RepositoryProviderStatus,
} from "@shared/contracts";

export type RepositoryCatalogStatus = "loading" | "ready" | "error";

export interface RepositoryCatalogState {
  status: RepositoryCatalogStatus;
  repositories: RepositoryOption[];
  providers: RepositoryProviderStatus[];
  refresh: () => void;
}

const noop = () => {};
const RepositoryCatalogContext = createContext<RepositoryCatalogState>({
  status: "loading",
  repositories: [],
  providers: [],
  refresh: noop,
});

export function RepositoryCatalogProvider({
  children,
  initial,
}: {
  children: React.ReactNode;
  initial?: {
    status: RepositoryCatalogStatus;
    repositories: RepositoryOption[];
    providers?: RepositoryProviderStatus[];
  };
}) {
  const [status, setStatus] = useState<RepositoryCatalogStatus>(
    initial?.status ?? "loading",
  );
  const [repositories, setRepositories] = useState<RepositoryOption[]>(
    initial?.repositories ?? [],
  );
  const [providers, setProviders] = useState<RepositoryProviderStatus[]>(
    initial?.providers ??
      [...new Set((initial?.repositories ?? []).map((repo) => repo.provider))].map(
        (provider) => ({ provider, status: "ready" as const }),
      ),
  );
  const listRequestId = useRef(0);

  const refresh = useCallback(() => {
    const id = ++listRequestId.current;
    setStatus("loading");
    fetch("/api/repositories", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<unknown>;
      })
      .then((result) => {
        if (id !== listRequestId.current) return;
        // A 200 carrying an unexpected body is as unusable as a bad status:
        // every consumer maps over `repositories`, so anything but an array has
        // to fail rather than land as a `ready` catalog that throws on render.
        const response = result as Partial<RepositoriesResponse> | null;
        const repositories = response?.repositories;
        const providers = response?.providers;
        if (!Array.isArray(repositories) || !Array.isArray(providers)) {
          throw new Error("malformed repository catalog");
        }
        setRepositories(repositories);
        setProviders(providers);
        setStatus("ready");
      })
      .catch(() => {
        if (id !== listRequestId.current) return;
        setStatus("error");
      });
  }, []);

  useEffect(() => {
    if (!initial) refresh();
  }, [initial, refresh]);

  return (
    <RepositoryCatalogContext.Provider
      value={{ status, repositories, providers, refresh }}
    >
      {children}
    </RepositoryCatalogContext.Provider>
  );
}

export function useRepositoryCatalog(): RepositoryCatalogState {
  return useContext(RepositoryCatalogContext);
}
