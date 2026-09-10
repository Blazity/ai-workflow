"use client";

import type { BlockRendererProps } from "./types";
import { InvestigateFields as SharedInvestigateFields } from "./shared";

export function InvestigateFields({ node, canEdit, onChange }: BlockRendererProps) {
  return <SharedInvestigateFields node={node} canEdit={canEdit} onChange={onChange} />;
}
