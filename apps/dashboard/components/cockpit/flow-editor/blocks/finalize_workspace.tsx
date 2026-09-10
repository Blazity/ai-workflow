"use client";

import { ConfigNote } from "./shared";
import type { BlockRendererProps } from "./types";

export function FinalizeWorkspaceFields(_props: BlockRendererProps) {
  return (
          <ConfigNote>
            To gate publication on check results, route a Branch using steps.&lt;id&gt;.output.allPassed
            for strict gating: it requires the selected groups to actually run and pass.
            steps.&lt;id&gt;.output.ok also passes when nothing matched, so prefer allPassed when
            publication should depend on scripts having run.
          </ConfigNote>
        );
}
