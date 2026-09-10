"use client";

import { ConfigNote } from "./shared";
import type { BlockRendererProps } from "./types";

export function ArthurInjectionCheckFields(_props: BlockRendererProps) {
  return <ConfigNote>Bind content to the string output that Arthur should scan.</ConfigNote>;
}
