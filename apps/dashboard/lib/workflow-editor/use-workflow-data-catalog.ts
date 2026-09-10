"use client";

import { useEffect, useRef, useState } from "react";
import type {
  WorkflowDefinitionCatalogResponse,
  WorkflowDefinitionV2,
} from "@shared/contracts";
import { apiClient } from "@/lib/api/client";
import { workflowCatalogFingerprint } from "./catalog-fingerprint";

export interface WorkflowDataCatalogState {
  fingerprint: string | null;
  response: WorkflowDefinitionCatalogResponse | null;
  refreshing: boolean;
  error: string | null;
}

export function useWorkflowDataCatalog(
  definitionId: number,
  definition: WorkflowDefinitionV2 | null,
): WorkflowDataCatalogState {
  const [state, setState] = useState<WorkflowDataCatalogState>({
    fingerprint: null,
    response: null,
    refreshing: false,
    error: null,
  });
  const latestFingerprint = useRef<string | null>(null);
  const definitionRef = useRef(definition);
  definitionRef.current = definition;

  const fingerprint = definition
    ? workflowCatalogFingerprint(definition)
    : null;

  useEffect(() => {
    latestFingerprint.current = fingerprint;
    const requestDefinition = definitionRef.current;
    if (!requestDefinition || !fingerprint) {
      setState({
        fingerprint: null,
        response: null,
        refreshing: false,
        error: null,
      });
      return;
    }
    const controller = new AbortController();
    setState((current) => ({
      ...current,
      refreshing: true,
      error: null,
    }));
    void apiClient.workflowDefinitions.catalog(
      definitionId,
      requestDefinition,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(response.errorMessage);
        return response.data;
      })
      .then((response) => {
        if (
          controller.signal.aborted ||
          latestFingerprint.current !== fingerprint
        ) {
          return;
        }
        setState({
          fingerprint,
          response,
          refreshing: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          latestFingerprint.current !== fingerprint
        ) {
          return;
        }
        setState((current) => ({
          ...current,
          refreshing: false,
          error:
            error instanceof Error
              ? error.message
              : "Could not refresh workflow values.",
        }));
      });
    return () => controller.abort();
  }, [definitionId, fingerprint]);

  return state;
}
