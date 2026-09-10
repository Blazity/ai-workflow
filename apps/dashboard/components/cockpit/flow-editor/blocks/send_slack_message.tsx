"use client";

import { Listbox } from "@/components/cockpit/listbox";
import { usePromptAuthoringContext } from "../prompt-authoring-context";
import { ConfigField, ConfigNote, RichTextField, str } from "./shared";
import type { BlockRendererProps } from "./types";

export function SendSlackMessageFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const promptAuthoring = usePromptAuthoringContext();
  const proseAuthoringMode = node.v2 ? "v2" : "v1";
  const proseValues = node.v2 ? (promptAuthoring?.availableValues ?? []) : [];
  {
        const sendOn = str(node.params.sendOn) === "always" ? "always" : "pr_ready";
        return (
          <>
            <ConfigField label="When to send">
              <Listbox
                options={[
                  { value: "pr_ready", label: "Only when a PR is ready" },
                  { value: "always", label: "Always (standalone message)" },
                ]}
                value={sendOn}
                disabled={!canEdit}
                ariaLabel="When to send"
                onChange={(v) => onChange("params.sendOn", v)}
              />
            </ConfigField>
            <ConfigField label="Message">
              <RichTextField
                value={str(node.params.message)}
                disabled={!canEdit}
                authoringMode={proseAuthoringMode}
                availableValues={proseValues}
                onChange={(v) => onChange("params.message", v)}
              />
            </ConfigField>
            <ConfigNote>
              {sendOn === "always"
                ? node.v2
                  ? "Posts your message as a standalone note in the ticket thread whenever this block runs. Use the Value picker to add a PR link when one is available."
                  : "Posts your message as a standalone note in the ticket thread whenever this block runs. Add {{pr_url}} if you want a PR link."
                : "Appends your message under the PR ready card, only after a pull request is published."}
            </ConfigNote>
          </>
        );
      }
}
