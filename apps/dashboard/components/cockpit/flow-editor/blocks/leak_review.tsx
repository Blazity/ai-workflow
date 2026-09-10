"use client";

import { ConfigField, ConfigNote, NumberField, TextInput, str } from "./shared";
import type { BlockRendererProps } from "./types";

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
              <label className="flex items-center gap-2 font-body text-xs text-coal">
                <input
                  type="checkbox"
                  checked={node.params.llmScan !== false}
                  disabled={!canEdit}
                  onChange={(e) => onChange("params.llmScan", e.target.checked)}
                  className="w-3.5 h-3.5 accent-mariner"
                />
                Add a report-only LLM screen for sensitive data
              </label>
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
