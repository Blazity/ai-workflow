"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import type { RepositoriesResponse, RepositoryOption } from "@shared/contracts";

export type RepositoryCatalogStatus = "loading" | "ready" | "error";

export interface RepositoryCatalogState {
  status: RepositoryCatalogStatus;
  repositories: RepositoryOption[];
  refresh: () => void;
}

const noop = () => {};
const RepositoryCatalogContext = createContext<RepositoryCatalogState>({
  status: "loading",
  repositories: [],
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
  };
}) {
  const [status, setStatus] = useState<RepositoryCatalogStatus>(
    initial?.status ?? "loading",
  );
  const [repositories, setRepositories] = useState<RepositoryOption[]>(
    initial?.repositories ?? [],
  );
  const listRequestId = useRef(0);

  const refresh = useCallback(() => {
    const id = ++listRequestId.current;
    setStatus("loading");
    fetch("/api/repositories", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<RepositoriesResponse>;
      })
      .then((result) => {
        if (id !== listRequestId.current) return;
        setRepositories(result.repositories);
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
    <RepositoryCatalogContext.Provider value={{ status, repositories, refresh }}>
      {children}
    </RepositoryCatalogContext.Provider>
  );
}

export function useRepositoryCatalog(): RepositoryCatalogState {
  return useContext(RepositoryCatalogContext);
}
