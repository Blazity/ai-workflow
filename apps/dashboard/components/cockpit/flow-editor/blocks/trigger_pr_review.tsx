"use client";

import { toggleRequiredArrayValue } from "@/lib/workflow-editor/params";
import { usePromptAuthoringContext } from "../prompt-authoring-context";
import { CheckboxRow, ConfigField, ConfigNote, NumberField, TriggerRateLimitFields, arr } from "./shared";
import { PrProvidersField, PrRepositoriesField, PrScopeField } from "./pr-trigger-fields";
import type { BlockRendererProps } from "./types";

export function TriggerPrReviewFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const promptAuthoring = usePromptAuthoringContext();
  const triggerDefinitionId = promptAuthoring?.previewCandidate?.definitionId;
  {
        const onStates = arr(node.params.on);
        const effective = onStates.length > 0 ? onStates : ["changes_requested"];
        const toggle = (value: string) => (checked: boolean) => {
          onChange("params.on", toggleRequiredArrayValue(effective, value, checked));
        };
        return (
          <>
            <PrProvidersField node={node} canEdit={canEdit} onChange={onChange} />
            <PrScopeField node={node} canEdit={canEdit} onChange={onChange} />
            <PrRepositoriesField node={node} canEdit={canEdit} />
            <ConfigField label="On review">
              <div className="flex flex-col gap-1.5">
                <CheckboxRow
                  label="Changes requested"
                  checked={effective.includes("changes_requested")}
                  disabled={
                    !canEdit ||
                    (effective.length === 1 && effective.includes("changes_requested"))
                  }
                  onChange={toggle("changes_requested")}
                />
                <CheckboxRow
                  label="Commented (untrusted body, opt-in)"
                  checked={effective.includes("commented")}
                  disabled={
                    !canEdit || (effective.length === 1 && effective.includes("commented"))
                  }
                  onChange={toggle("commented")}
                />
              </div>
            </ConfigField>
            <ConfigField label="Max runs per PR">
              <NumberField
                value={node.params.maxRunsPerPr}
                min={1}
                max={30}
                disabled={!canEdit}
                onChange={(v) => onChange("params.maxRunsPerPr", v)}
              />
            </ConfigField>
            <ConfigNote>
              Max runs per PR caps how many runs this trigger may start for one pull request
              before further deliveries are dropped.
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
}
