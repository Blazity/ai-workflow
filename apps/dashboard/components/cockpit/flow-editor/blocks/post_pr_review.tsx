"use client";

import { ConfigNote } from "./shared";
import type { BlockRendererProps } from "./types";

export function PostPrReviewFields(_props: BlockRendererProps) {
  return (
          <ConfigNote>
            Publishes the selected Review Results as one review. Findings that cannot be
            placed safely on the exact diff are included in the review summary.
          </ConfigNote>
        );
}
