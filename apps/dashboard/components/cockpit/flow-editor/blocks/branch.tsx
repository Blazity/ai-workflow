"use client";

import { parseCondition } from "@shared/conditions";
import { Input } from "@/components/ui";
import { ConfigField, str } from "./shared";
import type { BlockRendererProps } from "./types";

export function BranchFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  const condition = str(node.params.condition);
  const parsed = condition.trim() !== "" ? parseCondition(condition) : null;
  const error = parsed && !parsed.ok ? parsed.error : null;
  return (
    <ConfigField label="Condition">
      <Input
        value={condition}
        disabled={!canEdit}
        onChange={(e) => onChange("params.condition", e.target.value)}
        placeholder="steps.review.output.ok == true"
        size="sm"
        monospace
        className="h-[28px] min-w-0 px-2 bg-off-white border border-neutral-200 rounded-xs font-mono text-[11px] text-coal outline-none disabled:opacity-60"
      />
      {error && <div className="font-mono text-[11px] leading-[1.4] text-red-600">{error}</div>}
    </ConfigField>
  );
}
