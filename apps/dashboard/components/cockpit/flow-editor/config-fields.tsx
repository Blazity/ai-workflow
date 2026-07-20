"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { FlowNodeDef } from "@/lib/flows";
import type { WorkflowEditorOptions, WorkflowParamValue } from "@shared/contracts";
import { parseCondition } from "@shared/conditions";
import {
  arrayToLines,
  linesToArray,
  textMatchesLines,
  toggleRequiredArrayValue,
} from "@/lib/workflow-editor/params";
import { Listbox } from "@/components/cockpit/listbox";

const inputCls = "h-[26px] px-2 bg-off-white border border-neutral-200 rounded-xs font-mono text-xs text-coal outline-none disabled:opacity-60";
const textareaCls = "min-h-[64px] px-2 py-1.5 bg-off-white border border-neutral-200 rounded-xs font-body text-xs leading-[1.5] text-coal outline-none resize-y disabled:opacity-60";
const monoTextareaCls = "min-h-[64px] px-2 py-1.5 bg-off-white border border-neutral-200 rounded-xs font-mono text-xs leading-[1.5] text-coal outline-none resize-y disabled:opacity-60";

function str(value: WorkflowParamValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function arr(value: WorkflowParamValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function CheckboxRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 font-body text-xs text-coal">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="w-3.5 h-3.5 accent-mariner"
      />
      {label}
    </label>
  );
}

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

function TextInput({
  value,
  disabled,
  placeholder,
  onChange,
}: {
  value: string;
  disabled: boolean;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={inputCls}
    />
  );
}

function TextArea({
  value,
  disabled,
  mono,
  placeholder,
  onChange,
}: {
  value: string;
  disabled: boolean;
  mono?: boolean;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <textarea
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      rows={3}
      onChange={(e) => onChange(e.target.value)}
      className={mono ? monoTextareaCls : textareaCls}
    />
  );
}

function NumberField({
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  value: WorkflowParamValue | undefined;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={typeof value === "number" ? value : ""}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value === "") {
          onChange(undefined);
          return;
        }
        const n = Math.round(Number(e.target.value));
        if (!Number.isFinite(n)) return;
        onChange(Math.max(min, Math.min(max, n)));
      }}
      className={inputCls}
    />
  );
}

function ArrayTextarea({
  value,
  disabled,
  mono,
  placeholder,
  onChange,
}: {
  value: WorkflowParamValue | undefined;
  disabled: boolean;
  mono?: boolean;
  placeholder?: string;
  onChange: (v: string[] | undefined) => void;
}) {
  const [text, setText] = useState(() => arrayToLines(value));
  const [seed, setSeed] = useState(value);
  // A restore swaps params under a node whose id never changes, so the key cannot remount
  // us. Re-seed whenever the param is replaced by a value the textarea did not produce;
  // without the text check every keystroke would re-seed and eat the newline being typed.
  if (value !== seed) {
    setSeed(value);
    if (!textMatchesLines(text, value)) setText(arrayToLines(value));
  }
  return (
    <textarea
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      rows={3}
      onChange={(e) => {
        setText(e.target.value);
        const arr = linesToArray(e.target.value);
        onChange(arr.length > 0 ? arr : undefined);
      }}
      className={mono ? monoTextareaCls : textareaCls}
    />
  );
}

const CUSTOM_MODEL = "__custom__";
const CUSTOM_STATUS = "__custom_status__";

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

function TicketStatusField({
  value,
  targets,
  disabled,
  onChange,
}: {
  value: string;
  targets: { value: string; label: string }[];
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const known = targets.some((t) => t.value === value);
  const [customPicked, setCustomPicked] = useState(false);
  const custom = customPicked || (value !== "" && !known);

  return (
    <div className="flex flex-col gap-1.5">
      <Listbox
        options={[...targets, { value: CUSTOM_STATUS, label: "Custom…" }]}
        value={custom ? CUSTOM_STATUS : value}
        disabled={disabled}
        ariaLabel="Target status"
        onChange={(v) => {
          if (v === CUSTOM_STATUS) {
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

function AgentProviderModel({
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
  const provider = str(node.params.provider);
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
          value={str(node.params.model)}
          provider={provider}
          options={options}
          disabled={!canEdit}
          onChange={(v) => onChange("params.model", v)}
        />
      </ConfigField>
    </>
  );
}

function PrScopeField({
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

function PrProvidersField({
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
    case "trigger_plan_approved":
      return <ConfigNote>Fires when a proposed plan is approved.</ConfigNote>;
    case "trigger_pr_checks_failed":
      return (
        <>
          <PrProvidersField node={node} canEdit={canEdit} onChange={onChange} />
          <PrScopeField node={node} canEdit={canEdit} onChange={onChange} />
          <ConfigField label="Exact check names">
            <ArrayTextarea
              key={`${node.id}:checkNames`}
              value={node.params.checkNames}
              disabled={!canEdit}
              mono
              placeholder="ci / build"
              onChange={(value) => onChange("params.checkNames", value ?? [])}
            />
          </ConfigField>
          <ConfigField label="Trusted GitHub App slugs">
            <ArrayTextarea
              key={`${node.id}:githubAppSlugs`}
              value={node.params.githubAppSlugs}
              disabled={!canEdit}
              mono
              placeholder="github-actions"
              onChange={(value) => onChange("params.githubAppSlugs", value)}
            />
          </ConfigField>
          <ConfigField label="Trusted GitLab pipeline sources">
            <ArrayTextarea
              key={`${node.id}:gitlabPipelineSources`}
              value={node.params.gitlabPipelineSources}
              disabled={!canEdit}
              mono
              placeholder="merge_request_event"
              onChange={(value) => onChange("params.gitlabPipelineSources", value)}
            />
          </ConfigField>
          <ConfigNote>
            Events fail closed until an exact check name matches. GitHub defaults to the
            github-actions App; GitLab defaults to merge-request pipelines.
          </ConfigNote>
        </>
      );
    case "trigger_pr_created":
      return (
        <>
          <PrProvidersField node={node} canEdit={canEdit} onChange={onChange} />
          <PrScopeField node={node} canEdit={canEdit} onChange={onChange} />
          <ConfigNote>Only configured VCS integrations can receive these events.</ConfigNote>
        </>
      );
    case "trigger_pr_merged":
      return (
        <>
          <PrProvidersField node={node} canEdit={canEdit} onChange={onChange} />
          <PrScopeField node={node} canEdit={canEdit} onChange={onChange} />
          <ConfigNote>Fires after a pull or merge request is merged.</ConfigNote>
        </>
      );
    case "trigger_pr_review": {
      const onStates = arr(node.params.on);
      const effective = onStates.length > 0 ? onStates : ["changes_requested"];
      const toggle = (value: string) => (checked: boolean) => {
        onChange("params.on", toggleRequiredArrayValue(effective, value, checked));
      };
      return (
        <>
          <PrProvidersField node={node} canEdit={canEdit} onChange={onChange} />
          <PrScopeField node={node} canEdit={canEdit} onChange={onChange} />
          <ConfigField label="On review">
            <div className="flex flex-col gap-1.5">
              <CheckboxRow
                label="Changes requested"
                checked={effective.includes("changes_requested")}
                disabled={
                  !canEdit ||
                  (effective.length === 1 && effective.includes("changes_requested"))
                }
                onChange={toggle("changes_requested")}
              />
              <CheckboxRow
                label="Commented (untrusted body, opt-in)"
                checked={effective.includes("commented")}
                disabled={
                  !canEdit || (effective.length === 1 && effective.includes("commented"))
                }
                onChange={toggle("commented")}
              />
            </div>
          </ConfigField>
        </>
      );
    }
    case "planning_agent":
    case "implementation_agent":
    case "review_agent":
      return <AgentProviderModel node={node} options={options} canEdit={canEdit} onChange={onChange} />;
    case "fix_agent":
      return (
        <>
          <AgentProviderModel node={node} options={options} canEdit={canEdit} onChange={onChange} />
          <ConfigField label="Instructions">
            <TextArea value={str(node.params.instructions)} disabled={!canEdit} onChange={(v) => onChange("params.instructions", v)} />
          </ConfigField>
          <ConfigField label="Max minutes">
            <NumberField value={node.params.maxMinutes} min={5} max={60} disabled={!canEdit} onChange={(v) => onChange("params.maxMinutes", v)} />
          </ConfigField>
        </>
      );
    case "generic_agent":
      return (
        <>
          <AgentProviderModel node={node} options={options} canEdit={canEdit} onChange={onChange} />
          <ConfigField label="Workspace access">
            <Listbox
              options={[
                { value: "none", label: "No code workspace" },
                { value: "read_write", label: "Attached code workspace (read/write)" },
              ]}
              value={str(node.params.workspaceMode) || "none"}
              disabled={!canEdit}
              ariaLabel="Workspace access"
              onChange={(v) => onChange("params.workspaceMode", v)}
            />
          </ConfigField>
          <ConfigField label="Prompt">
            <TextArea value={str(node.params.prompt)} disabled={!canEdit} onChange={(v) => onChange("params.prompt", v)} />
          </ConfigField>
          <ConfigField label="Output schema">
            <TextArea value={str(node.params.outputSchema)} disabled={!canEdit} mono onChange={(v) => onChange("params.outputSchema", v)} />
          </ConfigField>
        </>
      );
    case "call_llm":
      return (
        <>
          <ConfigField label="Prompt">
            <TextArea value={str(node.params.prompt)} disabled={!canEdit} onChange={(v) => onChange("params.prompt", v)} />
          </ConfigField>
          <ConfigField label="System">
            <TextArea value={str(node.params.system)} disabled={!canEdit} onChange={(v) => onChange("params.system", v)} />
          </ConfigField>
          <ConfigField label="Model">
            <TextInput value={str(node.params.model)} disabled={!canEdit} onChange={(v) => onChange("params.model", v)} />
          </ConfigField>
          <ConfigField label="Output schema">
            <TextArea value={str(node.params.outputSchema)} disabled={!canEdit} mono onChange={(v) => onChange("params.outputSchema", v)} />
          </ConfigField>
        </>
      );
    case "prepare_workspace":
      return <ConfigNote>Creates or reuses a managed code workspace for modular blocks.</ConfigNote>;
    case "finalize_workspace":
      return (
        <ConfigNote>
          To gate publication on check results, route a Branch using steps.&lt;id&gt;.output.ok.
        </ConfigNote>
      );
    case "run_pre_pr_checks":
      return (
        <>
          <ConfigField label="Max fix cycles">
            <NumberField value={node.params.maxFixCycles} min={0} max={5} disabled={!canEdit} onChange={(v) => onChange("params.maxFixCycles", v)} />
          </ConfigField>
          <ConfigNote>
            Commands are configured in <Link href="/checks" className="text-mariner underline">Pre-PR checks</Link>.
          </ConfigNote>
        </>
      );
    case "run_checks":
      return (
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
      );
    case "fetch_pr_context":
      return <ConfigNote>Loads the pull request diff, files and metadata for downstream steps.</ConfigNote>;
    case "open_pr":
      return <ConfigNote>Opens a pull request with the agent&apos;s changes on the ticket branch.</ConfigNote>;
    case "update_ticket_status":
      return (
        <ConfigField label="Target status">
          <TicketStatusField
            key={node.id}
            value={str(node.params.target)}
            targets={options.ticketStatusTargets.map((t) => ({ value: t.value, label: t.label }))}
            disabled={!canEdit}
            onChange={(v) => onChange("params.target", v)}
          />
        </ConfigField>
      );
    case "post_ticket_comment":
      return (
        <ConfigField label="Body">
          <TextArea value={str(node.params.body)} disabled={!canEdit} onChange={(v) => onChange("params.body", v)} />
        </ConfigField>
      );
    case "post_pr_comment":
      return (
        <>
          <ConfigField label="Body">
            <TextArea value={str(node.params.body)} disabled={!canEdit} onChange={(v) => onChange("params.body", v)} />
          </ConfigField>
          <ConfigField label="Target">
            <Listbox
              options={[
                { value: "primary", label: "Primary PR" },
                { value: "all", label: "All PRs" },
              ]}
              value={str(node.params.target) || "primary"}
              disabled={!canEdit}
              ariaLabel="Target"
              onChange={(v) => onChange("params.target", v)}
            />
          </ConfigField>
        </>
      );
    case "send_slack_message":
      return (
        <ConfigField label="Message">
          <TextInput value={str(node.params.message)} disabled={!canEdit} onChange={(v) => onChange("params.message", v)} />
        </ConfigField>
      );
    case "human_question":
      return (
        <ConfigField label="Questions">
          <ArrayTextarea
            key={`${node.id}:questions`}
            value={node.params.questions}
            disabled={!canEdit}
            placeholder="One question per line"
            onChange={(v) => onChange("params.questions", v)}
          />
        </ConfigField>
      );
    case "send_plan_approval":
      return (
        <>
          <ConfigField label="Mirror comment">
            <label className="flex items-center gap-2 font-body text-xs text-coal">
              <input
                type="checkbox"
                checked={node.params.mirrorComment !== false}
                disabled={!canEdit}
                onChange={(e) => onChange("params.mirrorComment", e.target.checked)}
                className="w-3.5 h-3.5 accent-mariner"
              />
              Mirror the plan as a ticket comment
            </label>
          </ConfigField>
          <ConfigNote>
            Bind the plan input to an upstream output. The run resumes from the Plan approved trigger after approval.
          </ConfigNote>
        </>
      );
    case "arthur_injection_check":
      return <ConfigNote>Bind content to the string output that Arthur should scan.</ConfigNote>;
    case "branch": {
      const condition = str(node.params.condition);
      const parsed = condition.trim() !== "" ? parseCondition(condition) : null;
      const error = parsed && !parsed.ok ? parsed.error : null;
      return (
        <ConfigField label="Condition">
          <input
            value={condition}
            disabled={!canEdit}
            onChange={(e) => onChange("params.condition", e.target.value)}
            placeholder="steps.review.output.ok == true"
            className={inputCls}
          />
          {error && <div className="font-mono text-[11px] leading-[1.4] text-red-600">{error}</div>}
        </ConfigField>
      );
    }
    case "loop":
      return (
        <>
          <ConfigField label="Max attempts">
            <NumberField value={node.params.maxAttempts} min={1} max={20} disabled={!canEdit} onChange={(v) => onChange("params.maxAttempts", v)} />
          </ConfigField>
          <ConfigField label="On exhaust">
            <Listbox
              options={[
                { value: "fail", label: "Fail" },
                { value: "human", label: "Ask a human" },
                { value: "continue", label: "Continue" },
              ]}
              value={str(node.params.onExhaust) || "fail"}
              disabled={!canEdit}
              ariaLabel="On exhaust"
              onChange={(v) => onChange("params.onExhaust", v)}
            />
          </ConfigField>
        </>
      );
    case "terminate":
      return (
        <>
          <ConfigField label="Terminal status">
            <Listbox
              options={[
                { value: "done", label: "Done" },
                { value: "failed", label: "Failed" },
                { value: "skipped", label: "Skipped" },
                { value: "waiting_for_human", label: "Waiting for human" },
              ]}
              value={str(node.params.terminalStatus) || "done"}
              disabled={!canEdit}
              ariaLabel="Terminal status"
              onChange={(v) => onChange("params.terminalStatus", v)}
            />
          </ConfigField>
          <ConfigField label="Post comment">
            <TextArea value={str(node.params.postComment)} disabled={!canEdit} onChange={(v) => onChange("params.postComment", v)} />
          </ConfigField>
        </>
      );
  }
  return null;
}
