"use client";

import { PromptField } from "../prompt-field";
import { ConfigField, OutputSchemaField, TextInput, str } from "./shared";
import type { BlockRendererProps } from "./types";

export function CallLlmFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  return (
          <>
            <PromptField
              label="Prompt"
              paramKey="prompt"
              node={node}
              disabled={!canEdit}
              agentPromptAuthoring={false}
              onChange={onChange}
            />
            <PromptField
              label="System"
              paramKey="system"
              node={node}
              disabled={!canEdit}
              agentPromptAuthoring={false}
              onChange={onChange}
            />
            <ConfigField label="Model">
              <TextInput value={str(node.params.model)} disabled={!canEdit} onChange={(v) => onChange("params.model", v)} />
            </ConfigField>
            <OutputSchemaField node={node} disabled={!canEdit} onChange={onChange} />
          </>
        );
}
