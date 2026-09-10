"use client";

import { PromptField } from "../prompt-field";
import { AgentProviderModel, ConfigField, NumberField } from "./shared";
import type { BlockRendererProps } from "./types";

export function FixAgentFields(props: BlockRendererProps) {
  const { node, options, canEdit, onChange } = props;
  return (
          <>
            <AgentProviderModel node={node} options={options} canEdit={canEdit} onChange={onChange} />
            <PromptField
              label={node.v2 ? "Role / task instructions" : "Instructions"}
              paramKey="instructions"
              node={node}
              disabled={!canEdit}
              onChange={onChange}
            />
            <ConfigField label="Max minutes">
              <NumberField value={node.params.maxMinutes} min={5} max={60} disabled={!canEdit} onChange={(v) => onChange("params.maxMinutes", v)} />
            </ConfigField>
          </>
        );
}
