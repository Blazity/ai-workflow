"use client";

import { Listbox } from "@/components/cockpit/listbox";
import { PromptField } from "../prompt-field";
import { AgentProviderModel, ConfigField, OutputSchemaField, str } from "./shared";
import type { BlockRendererProps } from "./types";

export function GenericAgentFields(props: BlockRendererProps) {
  const { node, options, canEdit, onChange } = props;
  return (
          <>
            <AgentProviderModel node={node} options={options} canEdit={canEdit} onChange={onChange} />
            <ConfigField label="Workspace access">
              <Listbox
                options={[
                  { value: "none", label: "No code workspace" },
                  { value: "read_write", label: "Attached code workspace (read/write)" },
                ]}
                value={str(node.params.workspaceMode) || "none"}
                disabled={!canEdit}
                ariaLabel="Workspace access"
                onChange={(v) => onChange("params.workspaceMode", v)}
              />
            </ConfigField>
            <PromptField
              label={node.v2 ? "Role / task prompt" : "Prompt"}
              paramKey="prompt"
              node={node}
              disabled={!canEdit}
              onChange={onChange}
            />
            <OutputSchemaField node={node} disabled={!canEdit} onChange={onChange} />
          </>
        );
}
