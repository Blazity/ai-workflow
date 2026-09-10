"use client";

import { usePromptAuthoringContext } from "../prompt-authoring-context";
import { ScheduleTriggerFields } from "./trigger-schedule-fields";
import type { BlockRendererProps } from "./types";

export function TriggerScheduleFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const promptAuthoring = usePromptAuthoringContext();
  return (
          <ScheduleTriggerFields
            key={node.id}
            node={node}
            canEdit={canEdit}
            definitionId={promptAuthoring?.previewCandidate?.definitionId}
            onChange={onChange}
          />
        );
}
