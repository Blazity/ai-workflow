"use client";

import { usePromptAuthoringContext } from "../prompt-authoring-context";
import { ConfigField, RichTextField, str } from "./shared";
import type { BlockRendererProps } from "./types";

export function PostTicketCommentFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const promptAuthoring = usePromptAuthoringContext();
  const proseAuthoringMode = node.v2 ? "v2" : "v1";
  const proseValues = node.v2 ? (promptAuthoring?.availableValues ?? []) : [];
  return (
          <ConfigField label="Body">
            <RichTextField
              value={str(node.params.body)}
              disabled={!canEdit}
              authoringMode={proseAuthoringMode}
              availableValues={proseValues}
              onChange={(v) => onChange("params.body", v)}
            />
          </ConfigField>
        );
}
