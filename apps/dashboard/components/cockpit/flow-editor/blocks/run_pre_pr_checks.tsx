"use client";

import { ConfigNote } from "./shared";
import { GateSelectionField, RepositoryScriptsLink } from "./repository-script-fields";
import type { BlockRendererProps } from "./types";

export function RunPrePrChecksFields(props: BlockRendererProps) {
  const { node } = props;
  {
        const cycles = node.params.maxFixCycles;
        return (
          <>
            <GateSelectionField />
            <ConfigNote>
              This block runs the required groups on repositories the run changed. The selection
              above is resolved per repository in <RepositoryScriptsLink />.
            </ConfigNote>
            {typeof cycles === "number" && cycles > 0 ? (
              <ConfigNote>
                Fix cycles no longer apply: the repair loop was removed. The value is kept only for
                compatibility.
              </ConfigNote>
            ) : null}
          </>
        );
      }
}
