"use client";

import { useState } from "react";
import type { FlowNodeDef } from "@/lib/flows";
import type { WorkflowParamValue } from "@shared/contracts";
import { toggleRequiredArrayValue } from "@/lib/workflow-editor/params";
import { describeRepositoryScope } from "@/lib/workflow-editor/repository-scope";
import { Listbox } from "@/components/cockpit/listbox";
import { RepositoryScopeModal } from "../repository-scope-modal";
import { useRepositoryScopeContext } from "../repository-scope-context";
import { CheckboxRow, ConfigField, ConfigNote, arr } from "./shared";

export function PrScopeField({
  node,
  canEdit,
  onChange,
}: {
  node: FlowNodeDef;
  canEdit: boolean;
  onChange: (path: string, value: WorkflowParamValue | undefined) => void;
}) {
  const scope = node.params.scope === "any" ? "any" : "workflow_owned";
  return (
    <ConfigField label="Scope">
      <Listbox
        options={[
          { value: "workflow_owned", label: "Workflow-owned PRs only" },
          { value: "any", label: "Any PR" },
        ]}
        value={scope}
        disabled={!canEdit}
        ariaLabel="Pull request scope"
        onChange={(value) => onChange("params.scope", value)}
      />
    </ConfigField>
  );
}

export function PrProvidersField({
  node,
  canEdit,
  onChange,
}: {
  node: FlowNodeDef;
  canEdit: boolean;
  onChange: (path: string, value: WorkflowParamValue | undefined) => void;
}) {
  const configured = arr(node.params.providers).filter(
    (provider) => provider === "github" || provider === "gitlab",
  );
  const effective = configured.length > 0 ? configured : ["github", "gitlab"];
  const toggle = (provider: "github" | "gitlab") => (checked: boolean) => {
    onChange(
      "params.providers",
      toggleRequiredArrayValue(effective, provider, checked),
    );
  };

  return (
    <ConfigField label="Providers">
      <div className="flex flex-col gap-1.5">
        {(["github", "gitlab"] as const).map((provider) => {
          const checked = effective.includes(provider);
          return (
            <CheckboxRow
              key={provider}
              label={provider === "github" ? "GitHub" : "GitLab"}
              checked={checked}
              disabled={!canEdit || (checked && effective.length === 1)}
              onChange={toggle(provider)}
            />
          );
        })}
      </div>
    </ConfigField>
  );
}

/**
 * Read-only view of the definition-level repository pin, editable through the
 * same modal the top bar opens. The pin is not trigger params, so this panel
 * shows it where the operator is looking without becoming a second editing path
 * that could normalize it differently.
 */
export function PrRepositoriesField({
  node,
  canEdit,
}: {
  node: FlowNodeDef;
  canEdit: boolean;
}) {
  const repositoryScope = useRepositoryScopeContext();
  const [modalOpen, setModalOpen] = useState(false);
  if (!repositoryScope) return null;
  const summary = describeRepositoryScope(repositoryScope.scope);
  return (
    <>
      <ConfigField
        label="Repositories"
        action={
          <button
            type="button"
            aria-haspopup="dialog"
            disabled={!canEdit}
            onClick={() => setModalOpen(true)}
            className="appearance-none border-none bg-transparent cursor-pointer p-0 font-body text-[11px] text-mariner disabled:cursor-default disabled:opacity-40"
          >
            Configure repositories
          </button>
        }
      >
        <div className="font-body text-xs text-coal">
          {summary ?? "Automatic per ticket"}
        </div>
      </ConfigField>
      {node.params.scope !== "any" && (
        <ConfigNote>
          This list narrows which repositories the workflow may work in. With
          workflow-owned scope it is ownership, not this list, that admits an
          event: only pull requests AI Workflow opened reach this trigger.
        </ConfigNote>
      )}
      <RepositoryScopeModal
        open={modalOpen}
        scope={repositoryScope.scope}
        canEdit={canEdit}
        onApply={(next) => {
          repositoryScope.onChange(next);
          setModalOpen(false);
        }}
        onCancel={() => setModalOpen(false)}
      />
    </>
  );
}

/** Panels link to the Repositories page in a new tab. A client-side navigation out
 *  of the editor silently discards the unsaved canvas, and "see what a group
 *  runs" is exactly the errand an author runs mid-edit. */
