"use client";

import { DEFAULT_PROMPT_NAME_BY_AGENT } from "@shared/prompts";
import { PromptField } from "../prompt-field";
import { AgentProviderModel } from "./shared";
import type { BlockRendererProps } from "./types";

export function PlanningAgentFields(props: BlockRendererProps) {
  const { node, options, canEdit, onChange } = props;
  {
        return (
          <>
            <AgentProviderModel node={node} options={options} canEdit={canEdit} onChange={onChange} />
            <PromptField
              label={node.v2 ? "Role / task prompt" : "Prompt"}
              paramKey="prompt"
              node={node}
              disabled={!canEdit}
              mono
              defaultPromptName={DEFAULT_PROMPT_NAME_BY_AGENT[node.type]}
              onChange={onChange}
            />
          </>
        );
      }
}
