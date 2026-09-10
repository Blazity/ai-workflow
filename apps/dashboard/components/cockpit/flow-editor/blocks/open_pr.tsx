"use client";

import { DEFAULT_OPEN_PR_TITLE } from "@shared/prompts";
import { usePromptAuthoringContext } from "../prompt-authoring-context";
import { ConfigField, ConfigNote, RichTextField, TextInput, str } from "./shared";
import type { BlockRendererProps } from "./types";

export function OpenPrFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const promptAuthoring = usePromptAuthoringContext();
  const proseAuthoringMode = node.v2 ? "v2" : "v1";
  const proseValues = node.v2 ? (promptAuthoring?.availableValues ?? []) : [];
  return (
          <>
            <ConfigField label="Title">
              {node.v2 ? (
                <RichTextField
                  value={str(node.params.title)}
                  disabled={!canEdit}
                  authoringMode="v2"
                  availableValues={proseValues}
                  minHeightClass="min-h-[42px]"
                  compact
                  singleLine
                  onChange={(v) => onChange("params.title", v)}
                />
              ) : (
                <TextInput
                  value={str(node.params.title)}
                  disabled={!canEdit}
                  placeholder={DEFAULT_OPEN_PR_TITLE}
                  onChange={(v) => onChange("params.title", v)}
                />
              )}
            </ConfigField>
            <ConfigField label="Description">
              <RichTextField
                value={str(node.params.body)}
                disabled={!canEdit}
                authoringMode={proseAuthoringMode}
                availableValues={proseValues}
                onChange={(v) => onChange("params.body", v)}
              />
            </ConfigField>
            <ConfigNote>
              {node.v2
                ? "Use the Value picker to insert data guaranteed to be available at this step. Leave a field empty to use the default."
                : "Templates for the pull request opened on the ticket branch. Variables like {{ticket_key}}, {{ticket_title}}, {{ticket_url}} (issue tracker link) and {{change_summary}} (what the agent changed) are substituted at run time. Leave a field empty to use the default."}
            </ConfigNote>
          </>
        );
}
