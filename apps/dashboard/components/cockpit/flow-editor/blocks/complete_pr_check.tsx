"use client";

import { Select } from "@/components/ui";
import { usePromptAuthoringContext } from "../prompt-authoring-context";
import { ConfigField, ConfigNote, RichTextField, str } from "./shared";
import type { BlockRendererProps } from "./types";

export function CompletePrCheckFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const promptAuthoring = usePromptAuthoringContext();
  const proseAuthoringMode = node.v2 ? "v2" : "v1";
  const proseValues = node.v2 ? (promptAuthoring?.availableValues ?? []) : [];
  return (
          <>
            <ConfigField label="Conclusion">
              <Select
                options={[
                  { value: "success", label: "Success" },
                  { value: "failure", label: "Failure" },
                  { value: "neutral", label: "Neutral" },
                ]}
                value={str(node.params.conclusion) || "success"}
                disabled={!canEdit}
                aria-label="PR check conclusion"
                size="compact"
                onChange={(value) => onChange("params.conclusion", value)}
              />
            </ConfigField>
            <ConfigField label="Details">
              <RichTextField
                value={str(node.params.details)}
                disabled={!canEdit}
                authoringMode={proseAuthoringMode}
                availableValues={proseValues}
                onChange={(value) => onChange("params.details", value)}
              />
            </ConfigField>
            <ConfigNote>
              Only a check created by this run for the same PR head can be completed.
            </ConfigNote>
          </>
        );
}
