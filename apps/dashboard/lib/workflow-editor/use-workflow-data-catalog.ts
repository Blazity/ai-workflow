"use client";

import { useEffect, useRef, useState } from "react";
import type {
  WorkflowDefinitionCatalogResponse,
  WorkflowDefinitionV2,
} from "@shared/contracts";
import { readErrorMessage } from "@/lib/api/error-message";
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
    void fetch(`/api/workflow-definitions/${definitionId}/catalog`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definition: requestDefinition }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readErrorMessage(response));
        return (await response.json()) as WorkflowDefinitionCatalogResponse;
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
