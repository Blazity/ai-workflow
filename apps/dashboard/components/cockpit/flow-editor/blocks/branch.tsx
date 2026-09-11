"use client";

import { parseCondition } from "@shared/conditions";
import { ConfigField, inputCls, str } from "./shared";
import type { BlockRendererProps } from "./types";

export function BranchFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const condition = str(node.params.condition);
  const parsed = condition.trim() !== "" ? parseCondition(condition) : null;
  const error = parsed && !parsed.ok ? parsed.error : null;
  return (
    <ConfigField label="Condition">
      <input
        value={condition}
        disabled={!canEdit}
        onChange={(e) => onChange("params.condition", e.target.value)}
        placeholder="steps.review.output.ok == true"
        className={inputCls}
      />
      {error && <div className="font-mono text-[11px] leading-[1.4] text-red-600">{error}</div>}
    </ConfigField>
  );
}
