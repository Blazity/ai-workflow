"use client";

import { usePromptAuthoringContext } from "../prompt-authoring-context";
import { ArrayTextarea, CanonicalQuestionsField, ConfigField } from "./shared";
import type { BlockRendererProps } from "./types";

export function HumanQuestionFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const promptAuthoring = usePromptAuthoringContext();
  const proseValues = node.v2 ? (promptAuthoring?.availableValues ?? []) : [];
  const valuesRefreshing = promptAuthoring?.valuesRefreshing ?? false;
  return (
          <ConfigField label="Questions">
            {node.v2 ? (
              <CanonicalQuestionsField
                value={node.params.questions}
                disabled={!canEdit}
                availableValues={proseValues}
                valuesRefreshing={valuesRefreshing}
                onChange={(v) => onChange("params.questions", v)}
              />
            ) : (
              <ArrayTextarea
                key={`${node.id}:questions`}
                value={node.params.questions}
                disabled={!canEdit}
                placeholder="One question per line"
                onChange={(v) => onChange("params.questions", v)}
              />
            )}
          </ConfigField>
        );
}
