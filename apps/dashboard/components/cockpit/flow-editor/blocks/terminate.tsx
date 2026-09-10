"use client";

import { Listbox } from "@/components/cockpit/listbox";
import { usePromptAuthoringContext } from "../prompt-authoring-context";
import { ConfigField, RichTextField, str } from "./shared";
import type { BlockRendererProps } from "./types";

export function TerminateFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const promptAuthoring = usePromptAuthoringContext();
  const proseAuthoringMode = node.v2 ? "v2" : "v1";
  const proseValues = node.v2 ? (promptAuthoring?.availableValues ?? []) : [];
  return (
          <>
            <ConfigField label="Terminal status">
              <Listbox
                options={[
                  { value: "done", label: "Done" },
                  { value: "failed", label: "Failed" },
                  { value: "skipped", label: "Skipped" },
                  { value: "waiting_for_human", label: "Waiting for human" },
                ]}
                value={str(node.params.terminalStatus) || "done"}
                disabled={!canEdit}
                ariaLabel="Terminal status"
                onChange={(v) => onChange("params.terminalStatus", v)}
              />
            </ConfigField>
            <ConfigField label="Post comment">
              <RichTextField
                value={str(node.params.postComment)}
                disabled={!canEdit}
                authoringMode={proseAuthoringMode}
                availableValues={proseValues}
                onChange={(v) => onChange("params.postComment", v)}
              />
            </ConfigField>
          </>
        );
}
