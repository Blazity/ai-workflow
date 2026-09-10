"use client";

import { ConfigField, TicketStatusField, str } from "./shared";
import type { BlockRendererProps } from "./types";

export function UpdateTicketStatusFields(props: BlockRendererProps) {
  const { node, options, canEdit, onChange } = props;
  return (
          <ConfigField label="Target status">
            <TicketStatusField
              key={node.id}
              value={str(node.params.target)}
              targets={options.ticketStatusTargets.map((t) => ({ value: t.value, label: t.label }))}
              disabled={!canEdit}
              onChange={(v) => onChange("params.target", v)}
            />
          </ConfigField>
        );
}
