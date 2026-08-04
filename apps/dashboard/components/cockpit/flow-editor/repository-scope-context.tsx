"use client";

import { createContext, useContext } from "react";
import type { WorkflowRepositoryScope } from "@shared/contracts";

/** The definition-level repository pin belongs to no block, so the inspector
 *  reads it from the editor rather than from node params. One value, edited from
 *  the top bar or from a trigger panel, keeps a single source of truth. */
interface RepositoryScopeContextValue {
  scope: WorkflowRepositoryScope;
  onChange: (scope: WorkflowRepositoryScope) => void;
}

const RepositoryScopeContext =
  createContext<RepositoryScopeContextValue | null>(null);

export function RepositoryScopeProvider({
  scope,
  onChange,
  children,
}: RepositoryScopeContextValue & { children: React.ReactNode }) {
  return (
    <RepositoryScopeContext.Provider value={{ scope, onChange }}>
      {children}
    </RepositoryScopeContext.Provider>
  );
}

export function useRepositoryScopeContext(): RepositoryScopeContextValue | null {
  return useContext(RepositoryScopeContext);
}
