"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { FlowNodeDef } from "@/lib/flows";
import type { WorkflowEditorOptions, WorkflowParamValue } from "@shared/contracts";
import { Listbox } from "@/components/cockpit/listbox";

const inputCls = "h-[26px] px-2 bg-off-white border border-neutral-200 rounded-xs font-mono text-xs text-coal outline-none disabled:opacity-60";

function ConfigField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2.5 px-[14px] border-b border-neutral-200">
      <label className="font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase">{label}</label>
      {children}
    </div>
  );
}

function ConfigNote({ children }: { children: React.ReactNode }) {
  return <div className="py-2.5 px-[14px] border-b border-neutral-200 font-body text-xs leading-[1.5] text-neutral-700">{children}</div>;
}

const CUSTOM_MODEL = "__custom__";

function ProviderField({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: WorkflowEditorOptions;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <Listbox
      options={[
        { value: "", label: `Default (${options.agentKind})` },
        { value: "claude", label: "Claude Code" },
        { value: "codex", label: "OpenAI Codex" },
      ]}
      value={value}
      disabled={disabled}
      ariaLabel="Provider"
      onChange={onChange}
    />
  );
}

function ModelField({
  value,
  provider,
  options,
  disabled,
  onChange,
}: {
  value: string;
  provider: string;
  options: WorkflowEditorOptions;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const effectiveKind = provider === "claude" || provider === "codex" ? provider : options.agentKind;
  const defaultModel = options.defaultModels[effectiveKind];
  const models = options.models[effectiveKind];
  const list = useMemo(
    () => [defaultModel, ...models.filter((m) => m !== defaultModel)],
    [models, defaultModel],
  );
  const [customPicked, setCustomPicked] = useState(false);
  const custom = customPicked || (value !== "" && !list.includes(value));

  return (
    <div className="flex flex-col gap-1.5">
      <Listbox
        options={[...list.map((m) => ({ value: m, label: m })), { value: CUSTOM_MODEL, label: "Custom…" }]}
        value={custom ? CUSTOM_MODEL : value === "" ? defaultModel : value}
        disabled={disabled}
        ariaLabel="Model"
        onChange={(v) => {
          if (v === CUSTOM_MODEL) {
            setCustomPicked(true);
            return;
          }
          setCustomPicked(false);
          onChange(v);
        }}
      />
      {custom && (
        <input
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
        />
      )}
    </div>
  );
}

export function ConfigFields({
  node,
  options,
  canEdit,
  onChange,
}: {
  node: FlowNodeDef;
  options: WorkflowEditorOptions;
  canEdit: boolean;
  onChange: (path: string, value: WorkflowParamValue | undefined) => void;
}) {
  switch (node.type) {
    case "trigger_ticket_ai":
      return <ConfigNote>Fires when a Jira ticket enters the AI column.</ConfigNote>;
    case "planning_agent":
    case "implementation_agent":
    case "review_agent": {
      const provider = typeof node.params.provider === "string" ? node.params.provider : "";
      return (
        <>
          <ConfigField label="Provider">
            <ProviderField
              value={provider}
              options={options}
              disabled={!canEdit}
              onChange={(v) => {
                onChange("params.provider", v);
                if (v !== provider) onChange("params.model", "");
              }}
            />
          </ConfigField>
          <ConfigField label="Model">
            <ModelField
              key={`${node.id}:${provider}`}
              value={typeof node.params.model === "string" ? node.params.model : ""}
              provider={provider}
              options={options}
              disabled={!canEdit}
              onChange={(v) => onChange("params.model", v)}
            />
          </ConfigField>
        </>
      );
    }
    case "run_pre_pr_checks":
      return (
        <>
          <ConfigField label="Max fix cycles">
            <input
              type="number"
              min={0}
              max={5}
              value={typeof node.params.maxFixCycles === "number" ? node.params.maxFixCycles : ""}
              disabled={!canEdit}
              onChange={(e) => {
                if (e.target.value === "") {
                  onChange("params.maxFixCycles", undefined);
                  return;
                }
                const n = Math.round(Number(e.target.value));
                if (!Number.isFinite(n)) return;
                onChange("params.maxFixCycles", Math.max(0, Math.min(5, n)));
              }}
              className={inputCls}
            />
          </ConfigField>
          <ConfigNote>
            Commands are configured in <Link href="/checks" className="text-mariner underline">Pre-PR checks</Link>.
          </ConfigNote>
        </>
      );
    case "open_pr":
      return <ConfigNote>Opens a pull request with the agent&apos;s changes on the ticket branch.</ConfigNote>;
    case "update_ticket_status":
      return (
        <ConfigField label="Target status">
          <Listbox
            options={options.ticketStatusTargets.map((t) => ({ value: t.value, label: t.label }))}
            value={typeof node.params.target === "string" ? node.params.target : ""}
            disabled={!canEdit}
            ariaLabel="Target status"
            onChange={(v) => onChange("params.target", v)}
          />
        </ConfigField>
      );
    case "send_slack_message":
      return (
        <ConfigField label="Message">
          <input
            value={typeof node.params.message === "string" ? node.params.message : ""}
            disabled={!canEdit}
            onChange={(e) => onChange("params.message", e.target.value)}
            className={inputCls}
          />
        </ConfigField>
      );
  }
}
