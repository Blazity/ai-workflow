"use client";

import { createContext, useContext } from "react";
import type {
  JsonValue,
  WorkflowDataCatalogEntry,
  WorkflowDefinitionV2,
} from "@shared/contracts";

interface PromptAuthoringContextValue {
  availableValues: readonly WorkflowDataCatalogEntry[];
  valuesRefreshing?: boolean;
  onV2ConfigurationChange: (
    configuration: Record<string, JsonValue>,
  ) => void;
  previewCandidate?: {
    definitionId: number;
    definition: WorkflowDefinitionV2;
    blockId: string;
  };
}

const PromptAuthoringContext =
  createContext<PromptAuthoringContextValue | null>(null);

export function PromptAuthoringProvider({
  availableValues,
  valuesRefreshing,
  onV2ConfigurationChange,
  previewCandidate,
  children,
}: PromptAuthoringContextValue & { children: React.ReactNode }) {
  return (
    <PromptAuthoringContext.Provider
      value={{
        availableValues,
        valuesRefreshing,
        onV2ConfigurationChange,
        ...(previewCandidate === undefined ? {} : { previewCandidate }),
      }}
    >
      {children}
    </PromptAuthoringContext.Provider>
  );
}

export function usePromptAuthoringContext(): PromptAuthoringContextValue | null {
  return useContext(PromptAuthoringContext);
}
