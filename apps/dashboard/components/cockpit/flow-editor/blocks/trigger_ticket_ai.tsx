"use client";

import { usePromptAuthoringContext } from "../prompt-authoring-context";
import { ConfigNote, TriggerRateLimitFields } from "./shared";
import type { BlockRendererProps } from "./types";

export function TriggerTicketAiFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const promptAuthoring = usePromptAuthoringContext();
  const triggerDefinitionId = promptAuthoring?.previewCandidate?.definitionId;
  return (
          <>
            <ConfigNote>Fires when a Jira ticket enters the AI column.</ConfigNote>
            <TriggerRateLimitFields
              node={node}
              canEdit={canEdit}
              definitionId={triggerDefinitionId}
              onChange={onChange}
            />
          </>
        );
}
