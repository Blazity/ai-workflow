"use client";

import { ConfigNote } from "./shared";
import type { BlockRendererProps } from "./types";

export function TriggerPlanApprovedFields(_props: BlockRendererProps) {
  return <ConfigNote>Fires when a proposed plan is approved.</ConfigNote>;
}
