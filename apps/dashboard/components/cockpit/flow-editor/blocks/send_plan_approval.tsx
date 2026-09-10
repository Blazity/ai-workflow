"use client";

import { ConfigField, ConfigNote } from "./shared";
import type { BlockRendererProps } from "./types";

export function SendPlanApprovalFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  return (
          <>
            <ConfigField label="Mirror comment">
              <label className="flex items-center gap-2 font-body text-xs text-coal">
                <input
                  type="checkbox"
                  checked={node.params.mirrorComment !== false}
                  disabled={!canEdit}
                  onChange={(e) => onChange("params.mirrorComment", e.target.checked)}
                  className="w-3.5 h-3.5 accent-mariner"
                />
                Mirror the plan as a ticket comment
              </label>
            </ConfigField>
            <ConfigNote>
              Bind the plan input to an upstream output. The run resumes from the Plan approved trigger after approval.
            </ConfigNote>
          </>
        );
}
