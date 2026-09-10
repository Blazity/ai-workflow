"use client";

import { usePromptAuthoringContext } from "../prompt-authoring-context";
import { WebhookTriggerFields } from "./trigger-webhook-fields";
import type { BlockRendererProps } from "./types";

export function TriggerWebhookFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const promptAuthoring = usePromptAuthoringContext();
  return (
          <WebhookTriggerFields
            key={node.id}
            node={node}
            canEdit={canEdit}
            definitionId={promptAuthoring?.previewCandidate?.definitionId}
            onChange={onChange}
          />
        );
}
