"use client";

import { usePromptAuthoringContext } from "../prompt-authoring-context";
import { ArrayTextarea, ConfigField, ConfigNote, NumberField, TriggerRateLimitFields } from "./shared";
import { PrProvidersField, PrRepositoriesField, PrScopeField } from "./pr-trigger-fields";
import type { BlockRendererProps } from "./types";

export function TriggerPrChecksFailedFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const promptAuthoring = usePromptAuthoringContext();
  const triggerDefinitionId = promptAuthoring?.previewCandidate?.definitionId;
  return (
          <>
            <PrProvidersField node={node} canEdit={canEdit} onChange={onChange} />
            <PrScopeField node={node} canEdit={canEdit} onChange={onChange} />
            <PrRepositoriesField node={node} canEdit={canEdit} />
            <ConfigField label="Exact check names">
              <ArrayTextarea
                key={`${node.id}:checkNames`}
                value={node.params.checkNames}
                disabled={!canEdit}
                mono
                placeholder="ci / build"
                onChange={(value) => onChange("params.checkNames", value ?? [])}
              />
            </ConfigField>
            <ConfigField label="Ignored check names">
              <ArrayTextarea
                key={`${node.id}:ignoreCheckNames`}
                value={node.params.ignoreCheckNames}
                disabled={!canEdit}
                mono
                placeholder="lint"
                onChange={(value) => onChange("params.ignoreCheckNames", value ?? [])}
              />
            </ConfigField>
            <ConfigField label="Trusted check producers">
              <ArrayTextarea
                key={`${node.id}:trustedProducers`}
                value={node.params.trustedProducers}
                disabled={!canEdit}
                mono
                placeholder="ci-system"
                onChange={(value) => onChange("params.trustedProducers", value ?? [])}
              />
            </ConfigField>
            <ConfigField label="Max fix attempts per PR">
              <NumberField
                value={node.params.maxFixAttemptsPerPr}
                min={1}
                max={10}
                disabled={!canEdit}
                onChange={(v) => onChange("params.maxFixAttemptsPerPr", v)}
              />
            </ConfigField>
            <ConfigNote>
              Leave the check names empty to react to every failing check, or list names to
              narrow it to those. Leave trusted producers empty to use the provider's trusted
              default, or list producer identities to restrict it. Ignored check names never
              start a run even when they fail. Max fix attempts per PR caps how many automatic fix attempts one pull
              request may receive before the loop stops.
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
