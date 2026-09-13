"use client";

import { ConfigField, ConfigNote, NumberField, TextInput, str } from "./shared";
import type { BlockRendererProps } from "./types";
import { Checkbox } from "@/components/ui";

export function LeakReviewFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  return (
          <>
            <ConfigField label="Model">
              <TextInput
                value={str(node.params.model)}
                disabled={!canEdit}
                onChange={(v) => onChange("params.model", v)}
              />
            </ConfigField>
            <ConfigField label="LLM scan">
              <Checkbox
                checked={node.params.llmScan !== false}
                disabled={!canEdit}
                onChange={(event) => onChange("params.llmScan", event.target.checked)}
                label="Add a report-only LLM screen for sensitive data"
                className="text-xs text-coal"
              />
            </ConfigField>
            <ConfigField label="Max diff bytes">
              <NumberField
                value={node.params.maxDiffBytes}
                min={1}
                max={262144}
                disabled={!canEdit}
                onChange={(v) => onChange("params.maxDiffBytes", v)}
              />
            </ConfigField>
            <ConfigNote>
              The secret scan always runs and fails the run before the branch is pushed. The
              LLM screen only reports findings.
            </ConfigNote>
          </>
        );
}
