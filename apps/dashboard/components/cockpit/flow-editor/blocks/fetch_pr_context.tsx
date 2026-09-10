"use client";

import { ConfigNote } from "./shared";
import type { BlockRendererProps } from "./types";

export function FetchPrContextFields(_props: BlockRendererProps) {
  return <ConfigNote>Loads the pull request diff, files and metadata for downstream steps.</ConfigNote>;
}
