"use client";

import { ConfigField, ConfigNote, TextInput, str } from "./shared";
import type { BlockRendererProps } from "./types";

export function CreatePrCheckFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  return (
          <>
            <ConfigField label="Check name">
              <TextInput
                value={str(node.params.checkName)}
                disabled={!canEdit}
                onChange={(value) => onChange("params.checkName", value)}
              />
            </ConfigField>
            <ConfigNote>
              Creates a pending check for the exact pull request commit that started this run.
            </ConfigNote>
          </>
        );
}
