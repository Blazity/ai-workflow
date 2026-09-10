"use client";

import { ConfigNote } from "./shared";
import { RepositoryScriptsLink, RunScriptsGroupsField } from "./repository-script-fields";
import type { BlockRendererProps } from "./types";

export function RunScriptsFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  return (
          <>
            <RunScriptsGroupsField key={node.id} node={node} disabled={!canEdit} onChange={onChange} />
            <ConfigNote>
              Group names come from the repository&apos;s script groups, configured in{" "}
              <RepositoryScriptsLink />. output.ok is true when nothing matched; output.allPassed
              additionally requires that a selected group actually ran and passed. The block runs the
              selected groups on every repository in the run workspace, whether or not that
              repository changed.
            </ConfigNote>
          </>
        );
}
