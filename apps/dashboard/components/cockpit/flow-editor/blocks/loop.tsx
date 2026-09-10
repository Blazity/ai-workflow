"use client";

import { Listbox } from "@/components/cockpit/listbox";
import { ConfigField, NumberField, str } from "./shared";
import type { BlockRendererProps } from "./types";

export function LoopFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  return (
          <>
            <ConfigField label="Max attempts">
              <NumberField value={node.params.maxAttempts} min={1} max={20} disabled={!canEdit} onChange={(v) => onChange("params.maxAttempts", v)} />
            </ConfigField>
            <ConfigField label="On exhaust">
              <Listbox
                options={[
                  { value: "fail", label: "Fail" },
                  { value: "human", label: "Ask a human" },
                  { value: "continue", label: "Continue" },
                ]}
                value={str(node.params.onExhaust) || "fail"}
                disabled={!canEdit}
                ariaLabel="On exhaust"
                onChange={(v) => onChange("params.onExhaust", v)}
              />
            </ConfigField>
          </>
        );
}
