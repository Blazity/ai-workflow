"use client";

import { ConfigField, ConfigNote } from "./shared";
import type { BlockRendererProps } from "./types";
import { Checkbox } from "@/components/ui";

export function SendPlanApprovalFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  return (
          <>
            <ConfigField label="Mirror comment">
              <Checkbox
                checked={node.params.mirrorComment !== false}
                disabled={!canEdit}
                onChange={(event) => onChange("params.mirrorComment", event.target.checked)}
                label="Mirror the plan as a ticket comment"
                className="text-xs text-coal"
              />
            </ConfigField>
            <ConfigNote>
              Bind the plan input to an upstream output. The run resumes from the Plan approved trigger after approval.
            </ConfigNote>
          </>
        );
}
