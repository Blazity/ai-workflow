"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import type {
  RepositoriesResponse,
  RepositoryOption,
  RepositoryProviderStatus,
} from "@shared/contracts";
import { apiClient } from "@/lib/api/client";

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
    apiClient.repositories.list({ cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.data;
      })
      .then((result) => {
        if (id !== listRequestId.current) return;
        // A 200 carrying an unexpected body is as unusable as a bad status:
        // every consumer maps over `repositories`, so anything but an array has
        // to fail rather than land as a `ready` catalog that throws on render.
        const response = result as Partial<RepositoriesResponse> | null;
        const nextRepositories = response?.repositories;
        const nextProviders = response?.providers;
        if (!Array.isArray(nextRepositories) || !Array.isArray(nextProviders)) {
          // The thrown class is part of the public contract for the exported catalog provider.
          // oxlint-disable-next-line unicorn/prefer-type-error
          throw new Error("malformed repository catalog");
        }
        setRepositories(nextRepositories);
        setProviders(nextProviders);
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
