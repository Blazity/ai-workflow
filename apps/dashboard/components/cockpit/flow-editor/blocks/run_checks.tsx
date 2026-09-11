"use client";

import { ArrayTextarea, ConfigField, ConfigNote } from "./shared";
import { RepositoryScriptsLink, RunChecksGroupsField } from "./repository-script-fields";
import type { BlockRendererProps } from "./types";

export function RunChecksFields(props: BlockRendererProps) {
  const { node, canEdit, onChange } = props;
  // Mirrors the server's superRefine: filling both is a client-visible
  // error, not just prose an author can miss until publish rejects it.
  const runChecksCommands = Array.isArray(node.params.commands) ? node.params.commands : [];
  const runChecksGroups = Array.isArray(node.params.groups) ? node.params.groups : [];
  const commandsAndGroupsBothSet = runChecksCommands.length > 0 && runChecksGroups.length > 0;
  return (
    <>
      <ConfigField label="Commands">
        <ArrayTextarea
          key={`${node.id}:commands`}
          value={node.params.commands}
          disabled={!canEdit}
          mono
          placeholder="pnpm test"
          onChange={(v) => onChange("params.commands", v)}
        />
      </ConfigField>
      <RunChecksGroupsField key={node.id} node={node} disabled={!canEdit} onChange={onChange} />
      {commandsAndGroupsBothSet ? (
        <div className="py-2.5 px-[14px] border-b border-neutral-200">
          <div className="rounded-xs border border-red-200 bg-red-50 px-2 py-1.5 font-body text-[11px] leading-[1.4] text-red-700">
            Commands and Groups are both set. They are mutually exclusive: clear one
            before saving.
          </div>
        </div>
      ) : null}
      <ConfigNote>
        Groups and explicit commands are mutually exclusive server-side: set one or the
        other, not both. Group names come from the repository&apos;s script groups,
        configured in <RepositoryScriptsLink />.
      </ConfigNote>
    </>
  );
}
