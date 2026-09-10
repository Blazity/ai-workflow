"use client";

import { Listbox } from "@/components/cockpit/listbox";
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
              <Listbox
                options={[
                  { value: "success", label: "Success" },
                  { value: "failure", label: "Failure" },
                  { value: "neutral", label: "Neutral" },
                ]}
                value={str(node.params.conclusion) || "success"}
                disabled={!canEdit}
                ariaLabel="PR check conclusion"
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
