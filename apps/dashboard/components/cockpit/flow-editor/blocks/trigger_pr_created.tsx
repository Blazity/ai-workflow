"use client";

import { usePromptAuthoringContext } from "../prompt-authoring-context";
import { ConfigNote, TriggerRateLimitFields } from "./shared";
import { PrProvidersField, PrRepositoriesField, PrScopeField } from "./pr-trigger-fields";
import type { BlockRendererProps } from "./types";

export function TriggerPrCreatedFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const promptAuthoring = usePromptAuthoringContext();
  const triggerDefinitionId = promptAuthoring?.previewCandidate?.definitionId;
  return (
          <>
            <PrProvidersField node={node} canEdit={canEdit} onChange={onChange} />
            <PrScopeField node={node} canEdit={canEdit} onChange={onChange} />
            <PrRepositoriesField node={node} canEdit={canEdit} />
            <ConfigNote>
              {node.type === "trigger_pr_ready"
                ? "Fires when a non-draft PR opens, reopens, or becomes ready for review."
                : node.type === "trigger_pr_updated"
                  ? "Fires only when the PR head commit changes."
                  : "Only configured VCS integrations can receive these events."}
            </ConfigNote>
            <TriggerRateLimitFields
              node={node}
              canEdit={canEdit}
              definitionId={triggerDefinitionId}
              onChange={onChange}
            />
          </>
        );
}
