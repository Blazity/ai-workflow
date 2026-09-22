"use client";

import { useState } from "react";
import type { FlowNodeDef } from "@/lib/flows";
import type { WorkflowParamValue } from "@shared/contracts";
import {
  PINNABLE_PROVIDERS,
  describeRepositoryScope,
  providerLabel,
} from "@/lib/workflow-editor/repository-scope";
import { Button, Select } from "@/components/ui";
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
      <Select
        options={[
          { value: "workflow_owned", label: "Workflow-owned PRs only" },
          { value: "any", label: "Any PR" },
        ]}
        value={scope}
        disabled={!canEdit}
        aria-label="Pull request scope"
        size="compact"
        onChange={(value) => onChange("params.scope", value)}
      />
    </ConfigField>
  );
}

/**
 * Which providers' pull requests start this trigger: one checkbox per version
 * control provider the registry ships, named the way its integration names
 * itself. None ticked is the stored default and admits every connected
 * provider, so it is said in words rather than drawn as every box ticked: a
 * list that ticks every box would store every id on the first click and stop
 * admitting a provider added later.
 *
 * A stored id this build does not ship (a definition from a build with one
 * more provider, or one written through the API) keeps its own row until the
 * author removes it. The dispatcher compares ids, so such an id matches no
 * event; dropping it on the next toggle would change what the trigger admits
 * without anybody choosing that.
 */
export function PrProvidersField({
  node,
  canEdit,
  onChange,
}: {
  node: FlowNodeDef;
  canEdit: boolean;
  onChange: (path: string, value: WorkflowParamValue | undefined) => void;
}) {
  const stored = arr(node.params.providers);
  const unknown = stored.filter((provider) => !PINNABLE_PROVIDERS.includes(provider));
  const shippedPicked = stored.length - unknown.length > 0;
  const write = (next: string[]) => onChange("params.providers", next);

  return (
    <ConfigField label="Providers">
      <div className="flex flex-col gap-1.5">
        {PINNABLE_PROVIDERS.map((provider) => {
          const checked = stored.includes(provider);
          return (
            <CheckboxRow
              key={provider}
              label={providerLabel(provider)}
              checked={checked}
              disabled={!canEdit}
              onChange={(next) =>
                write(
                  next
                    ? [...stored, provider]
                    : stored.filter((entry) => entry !== provider),
                )
              }
            />
          );
        })}
        {unknown.map((provider) => (
          <div key={provider} className="flex items-center gap-2 font-body text-xs text-coal">
            <span className="font-mono">{provider}</span>
            <span className="text-neutral-500">Unknown provider</span>
            <Button
              type="button"
              variant="text"
              size="sm"
              aria-label={`Remove ${provider}`}
              disabled={!canEdit}
              onClick={() => write(stored.filter((entry) => entry !== provider))}
              className="ml-auto appearance-none border-none bg-transparent cursor-pointer p-0 font-body text-[11px] text-mariner disabled:cursor-default disabled:opacity-40"
            >
              Remove
            </Button>
          </div>
        ))}
        {stored.length === 0 ? (
          <p className="m-0 font-body text-[11px] text-neutral-500">
            None ticked: a pull request from any connected provider starts it.
          </p>
        ) : !shippedPicked ? (
          <p className="m-0 font-body text-[11px] text-fail-fg">
            This build ships no provider named here, so this trigger never fires.
            Tick a provider above or remove the unknown one.
          </p>
        ) : null}
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
          <Button
            type="button"
            variant="text"
            size="sm"
            aria-haspopup="dialog"
            disabled={!canEdit}
            onClick={() => setModalOpen(true)}
            className="appearance-none border-none bg-transparent cursor-pointer p-0 font-body text-[11px] text-mariner disabled:cursor-default disabled:opacity-40"
          >
            Configure repositories
          </Button>
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
