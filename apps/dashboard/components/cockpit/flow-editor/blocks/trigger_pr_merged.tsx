"use client";

import { usePromptAuthoringContext } from "../prompt-authoring-context";
import { ConfigNote, TriggerRateLimitFields } from "./shared";
import { PrProvidersField, PrRepositoriesField, PrScopeField } from "./pr-trigger-fields";
import type { BlockRendererProps } from "./types";

export function TriggerPrMergedFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const promptAuthoring = usePromptAuthoringContext();
  const triggerDefinitionId = promptAuthoring?.previewCandidate?.definitionId;
  return (
          <>
            <PrProvidersField node={node} canEdit={canEdit} onChange={onChange} />
            <PrScopeField node={node} canEdit={canEdit} onChange={onChange} />
            <PrRepositoriesField node={node} canEdit={canEdit} />
            <ConfigNote>Fires after a pull or merge request is merged.</ConfigNote>
            <TriggerRateLimitFields
              node={node}
              canEdit={canEdit}
              definitionId={triggerDefinitionId}
              onChange={onChange}
            />
          </>
        );
}
