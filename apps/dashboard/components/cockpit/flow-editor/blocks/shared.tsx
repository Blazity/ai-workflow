"use client";

import { useEffect, useState, useMemo } from "react";
import type { FlowNodeDef } from "@/lib/flows";
import type { WebhookRejectionSummaryEntry, WorkflowDataCatalogEntry, WorkflowEditorOptions, WorkflowParamValue } from "@shared/contracts";
import { arrayToLines, linesToArray, textMatchesLines } from "@/lib/workflow-editor/params";
import { Listbox } from "@/components/cockpit/listbox";
import { investigateProviders } from "../block-palette";
import { PromptEditor } from "@/components/cockpit/prompt-editor/prompt-editor";
import { WorkflowTextTemplateEditor } from "../workflow-text-template-editor";
import { JsonSchemaEditor } from "../json-schema-editor";
import { usePromptAuthoringContext } from "../prompt-authoring-context";
import { AgentHarnessProfile } from "../agent-harness-profile";
import type { ConfigChange } from "./types";
import { apiClient } from "@/lib/api/client";

export const inputCls = "h-[26px] px-2 bg-off-white border border-neutral-200 rounded-xs font-mono text-xs text-coal outline-none disabled:opacity-60";
const textareaCls = "min-h-[64px] px-2 py-1.5 bg-off-white border border-neutral-200 rounded-xs font-body text-xs leading-[1.5] text-coal outline-none resize-y disabled:opacity-60";
const monoTextareaCls = "min-h-[64px] px-2 py-1.5 bg-off-white border border-neutral-200 rounded-xs font-mono text-xs leading-[1.5] text-coal outline-none resize-y disabled:opacity-60";

export function str(value: WorkflowParamValue | undefined): string {
  return typeof value === "string" ? value : "";
}

export function arr(value: WorkflowParamValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function CheckboxRow({
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

export function ConfigField({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 py-2.5 px-[14px] border-b border-neutral-200">
      {action ? (
        <div className="flex items-center gap-2">
          <label className="font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase">{label}</label>
          <div className="ml-auto flex items-center gap-1">{action}</div>
        </div>
      ) : (
        <label className="font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase">{label}</label>
      )}
      {children}
    </div>
  );
}

export function ConfigNote({ children }: { children: React.ReactNode }) {
  return <div className="py-2.5 px-[14px] border-b border-neutral-200 font-body text-xs leading-[1.5] text-neutral-700">{children}</div>;
}

export function TextInput({
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

export function TextArea({
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

export function OutputSchemaField({
  node,
  disabled,
  onChange,
}: {
  node: FlowNodeDef;
  disabled: boolean;
  onChange: ConfigChange;
}) {
  return (
    <ConfigField label="Output schema">
      <JsonSchemaEditor
        label={`${node.name ?? node.id} output schema`}
        value={str(node.params.outputSchema)}
        disabled={disabled}
        onChange={(value) => onChange("params.outputSchema", value)}
        onDialectChange={
          node.v2
            ? (dialect) => {
                if (node.v2?.configuration.outputSchemaDialect !== dialect) {
                  onChange("params.outputSchemaDialect", dialect);
                }
              }
            : undefined
        }
      />
    </ConfigField>
  );
}

/** Rich text (Tiptap) surface for prose params: Slack messages, comment bodies.
 *  Reuses the prompt editor so these fields match the Prompt Library editor and
 *  get {{variable}} insertion + highlighting for free. Markdown is the stored
 *  value; the worker substitutes {{variables}} at runtime per VARIABLE_PARAM_KEYS. */
export function RichTextField({
  value,
  disabled,
  minHeightClass,
  authoringMode = "v1",
  availableValues = [],
  valuesRefreshing,
  compact,
  singleLine,
  onChange,
}: {
  value: string;
  disabled: boolean;
  minHeightClass?: string;
  authoringMode?: "v1" | "v2";
  availableValues?: readonly WorkflowDataCatalogEntry[];
  valuesRefreshing?: boolean;
  compact?: boolean;
  singleLine?: boolean;
  onChange: (v: string) => void;
}) {
  const promptAuthoring = usePromptAuthoringContext();
  const refreshing =
    valuesRefreshing ?? promptAuthoring?.valuesRefreshing ?? false;
  if (authoringMode === "v2") {
    return (
      <WorkflowTextTemplateEditor
        value={value}
        disabled={disabled}
        entries={availableValues}
        refreshing={refreshing}
        minHeightClass={minHeightClass ?? "min-h-[96px]"}
        singleLine={singleLine}
        onChange={onChange}
      />
    );
  }
  return (
    <PromptEditor
      value={value}
      disabled={disabled}
      minHeightClass={minHeightClass ?? "min-h-[96px]"}
      authoringMode={authoringMode}
      compact={compact}
      singleLine={singleLine}
      onChange={onChange}
    />
  );
}

export function CanonicalQuestionsField({
  value,
  disabled,
  availableValues,
  valuesRefreshing,
  onChange,
}: {
  value: WorkflowParamValue | undefined;
  disabled: boolean;
  availableValues: readonly WorkflowDataCatalogEntry[];
  valuesRefreshing?: boolean;
  onChange: (value: string[] | undefined) => void;
}) {
  const questions = Array.isArray(value)
    ? value.filter((question): question is string => typeof question === "string")
    : [];
  const visibleQuestions = questions.length > 0 ? questions : [""];
  const update = (index: number, question: string) => {
    const next = [...visibleQuestions];
    next[index] = question;
    onChange(next.some((candidate) => candidate.trim().length > 0) ? next : undefined);
  };

  return (
    <div className="flex flex-col gap-2">
      {visibleQuestions.map((question, index) => (
        <div
          key={`${index}:${visibleQuestions.length}`}
          className="flex items-start gap-1.5"
        >
          <div className="min-w-0 flex-1">
            <WorkflowTextTemplateEditor
              value={question}
              disabled={disabled}
              entries={availableValues}
              refreshing={valuesRefreshing}
              minHeightClass="min-h-[54px]"
              onChange={(next) => update(index, next)}
            />
          </div>
          {visibleQuestions.length > 1 && (
            <button
              type="button"
              disabled={disabled}
              aria-label={`Remove question ${index + 1}`}
              onClick={() => {
                const next = visibleQuestions.filter(
                  (_, candidate) => candidate !== index,
                );
                onChange(
                  next.some((candidate) => candidate.trim().length > 0)
                    ? next
                    : undefined,
                );
              }}
              className="appearance-none rounded-xs border border-neutral-200 bg-panel px-2 py-1 font-mono text-[9px] uppercase tracking-[0.04em] text-red-700 disabled:opacity-40"
            >
              Remove
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange([...visibleQuestions, ""])}
        className="self-start appearance-none rounded-xs border border-mariner bg-panel px-2 py-1 font-mono text-[9px] uppercase tracking-[0.04em] text-mariner disabled:opacity-40"
      >
        + Add question
      </button>
    </div>
  );
}

export function NumberField({
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

export function ArrayTextarea({
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
      // Mono lists are identifiers (commands, check names, group names), which
      // the browser spellchecker underlines wholesale. Prose lists keep it.
      spellCheck={mono ? false : undefined}
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

const TRIGGER_RATE_LIMIT_WINDOW_OPTIONS = [
  { value: "minute", label: "Per minute" },
  { value: "hour", label: "Per hour" },
  { value: "day", label: "Per day" },
  { value: "month", label: "Per calendar month (UTC)" },
];

/**
 * When the trigger's current fixed window rolls over, in UTC. Mirrors the
 * worker's triggerRateWindowStart: minute, hour and day floor the epoch (which
 * is UTC), and a month is the UTC calendar month rather than 30 days. Duplicated
 * here rather than fetched because it is arithmetic on a value the editor
 * already holds, and an operator reading a refusal needs "until when" without a
 * round trip.
 */
function triggerRateWindowResetAt(window: string, now: Date): Date {
  if (window === "month") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }
  const windowMs =
    window === "minute" ? 60_000 : window === "hour" ? 3_600_000 : 86_400_000;
  return new Date((Math.floor(now.getTime() / windowMs) + 1) * windowMs);
}

/** Today's starts this trigger's rate limit refused, from the worker's
 *  per-node rejection counters. Renders nothing while loading, on error, or
 *  when there is nothing to show: an idle trigger and a failed fetch look the
 *  same, and neither deserves a banner. */
function TriggerRejectionsNote({
  definitionId,
  nodeId,
  limit,
}: {
  definitionId: number | undefined;
  nodeId: string;
  /** The configured limit, so the banner can say what was exceeded and when it
   *  resets. Absent for an unlimited node, which never has rejections anyway. */
  limit?: { max: number; window: string };
}) {
  const [entries, setEntries] = useState<readonly WebhookRejectionSummaryEntry[]>([]);
  useEffect(() => {
    if (definitionId === undefined) return;
    let cancelled = false;
    apiClient.triggers.rejections(definitionId, nodeId, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) return;
        const payload = response.data;
        if (!cancelled) {
          setEntries(
            Array.isArray(payload.rejectionsToday) ? payload.rejectionsToday : [],
          );
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [definitionId, nodeId]);
  if (entries.length === 0) return null;
  return (
    <div className="py-2.5 px-[14px] border-b border-neutral-200">
      <div className="rounded-xs border border-red-200 bg-red-50 px-2 py-1.5">
        <div className="font-mono text-[8px] uppercase tracking-[0.05em] text-red-800">
          Rejected by the rate limit today
        </div>
        {limit && (
          <div className="mt-1 font-body text-[11px] leading-[1.35] text-red-800">
            Limit {limit.max} per {limit.window}; this window resets at{" "}
            {triggerRateWindowResetAt(limit.window, new Date())
              .toISOString()
              .replace("T", " ")
              .slice(0, 16)}{" "}
            UTC.
          </div>
        )}
        <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
          {entries.map((entry) => (
            <li
              key={entry.reason}
              className="list-none font-body text-[11px] leading-[1.35] text-red-800"
            >
              <span className="font-mono">
                {entry.reason} {entry.count}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The per-node start limit every automatic trigger accepts. Both params are
 *  optional; an empty max means unlimited. The window is written together with
 *  the max (defaulting to per day) and cleared with it, so a stored config
 *  always carries the pair or neither. */
export function TriggerRateLimitFields({
  node,
  canEdit,
  definitionId,
  webhook,
  schedule,
  onChange,
}: {
  node: FlowNodeDef;
  canEdit: boolean;
  definitionId: number | undefined;
  webhook?: boolean;
  schedule?: boolean;
  onChange: ConfigChange;
}) {
  const max =
    typeof node.params.rateLimitMax === "number" ? node.params.rateLimitMax : undefined;
  const windowValue = str(node.params.rateLimitWindow);
  return (
    <>
      <ConfigField label="Max workflow starts">
        <NumberField
          value={max}
          min={1}
          max={1000000}
          disabled={!canEdit}
          onChange={(v) => {
            onChange("params.rateLimitMax", v);
            if (v === undefined) onChange("params.rateLimitWindow", undefined);
            else if (windowValue === "") onChange("params.rateLimitWindow", "day");
          }}
        />
      </ConfigField>
      {max !== undefined && (
        <ConfigField label="Rate limit window">
          <Listbox
            options={TRIGGER_RATE_LIMIT_WINDOW_OPTIONS}
            value={windowValue || "day"}
            disabled={!canEdit}
            ariaLabel="Rate limit window"
            onChange={(v) => onChange("params.rateLimitWindow", v)}
          />
        </ConfigField>
      )}
      <ConfigNote>
        Starts above the limit are refused and counted below until the window
        resets. Windows are fixed, so up to 2× the limit can start around a
        window boundary; a month is a calendar month in UTC. Leave empty for
        unlimited starts. This caps how many runs may START, not how many run at
        once: the shared run pool still decides that, and a start that waits or
        is dropped for capacity never spends the limit. Manual dispatch and
        restarts from approvals are not limited.
        {webhook
          ? " This node limit applies in addition to the endpoint's own limits (600/min ingress, 60/min inbox), so the tightest of the three wins."
          : ""}
        {schedule
          ? " An occurrence refused by the limit is skipped, the same way the skip overlap policy skips one, and is never replayed once the window resets."
          : ""}
      </ConfigNote>
      <TriggerRejectionsNote
        definitionId={definitionId}
        nodeId={node.id}
        {...(max === undefined
          ? {}
          : { limit: { max, window: windowValue || "day" } })}
      />
    </>
  );
}

/** Config for the investigate block. The providers param is a selection list of
 *  provider names, like the VCS providers on the PR triggers. */
export function InvestigateFields({
  node,
  canEdit,
  onChange,
}: {
  node: FlowNodeDef;
  canEdit: boolean;
  onChange: ConfigChange;
}) {
  const providers = investigateProviders(node);
  const toggleProvider = (key: "jira" | "slack") => (checked: boolean) => {
    const next = { ...providers, [key]: checked };
    // Keeping the last provider on: an empty selection fails validation, and
    // silently writing one would make the node undeployable from a checkbox.
    if (!next.jira && !next.slack) return;
    onChange(
      "params.providers",
      (["jira", "slack"] as const).filter((name) => next[name]),
    );
  };
  const writeOptional = (key: string) => (value: string) =>
    onChange(`params.${key}`, value.trim() === "" ? undefined : value);
  return (
    <>
      <ConfigField label="Context providers">
        <div className="flex flex-col gap-1.5">
          <CheckboxRow
            label="Jira (similar tickets)"
            checked={providers.jira}
            disabled={!canEdit}
            onChange={toggleProvider("jira")}
          />
          <CheckboxRow
            label="Slack (channel history)"
            checked={providers.slack}
            disabled={!canEdit}
            onChange={toggleProvider("slack")}
          />
        </div>
      </ConfigField>
      {providers.slack && (
        <>
          <ConfigField label="Slack channels">
            <ArrayTextarea
              key={`${node.id}:slackChannels`}
              value={node.params.slackChannels}
              disabled={!canEdit}
              mono
              placeholder="C0123456789"
              onChange={(v) => onChange("params.slackChannels", v)}
            />
          </ConfigField>
          <ConfigField label="Slack lookback (days)">
            <NumberField
              value={node.params.slackLookbackDays ?? 30}
              min={1}
              max={365}
              disabled={!canEdit}
              onChange={(v) => onChange("params.slackLookbackDays", v)}
            />
          </ConfigField>
          <ConfigNote>
            One channel ID per line. The workflow bot must be invited to each
            channel; a channel without it is skipped. An empty list skips Slack.
          </ConfigNote>
        </>
      )}
      {providers.jira && (
        <>
          <ConfigField label="Jira JQL template (optional)">
            <TextInput
              value={str(node.params.jiraJqlTemplate)}
              disabled={!canEdit}
              placeholder="labels = support"
              onChange={writeOptional("jiraJqlTemplate")}
            />
          </ConfigField>
          <ConfigNote>
            The search is always restricted to the Jira project this deployment
            is configured for. A template narrows within that project; it cannot
            reach another one, so naming a different project simply finds
            nothing.
          </ConfigNote>
        </>
      )}
      <ConfigField label="Max results per provider">
        <NumberField
          value={node.params.maxResults ?? 10}
          min={1}
          max={10}
          disabled={!canEdit}
          onChange={(v) => onChange("params.maxResults", v)}
        />
      </ConfigField>
      <ConfigField label="Model (optional)">
        <TextInput
          value={str(node.params.model)}
          disabled={!canEdit}
          onChange={writeOptional("model")}
        />
      </ConfigField>
    </>
  );
}


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

export function TicketStatusField({
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

export function AgentProviderModel({
  node,
  options,
  canEdit,
  onChange,
}: {
  node: FlowNodeDef;
  options: WorkflowEditorOptions;
  canEdit: boolean;
  onChange: ConfigChange;
}) {
  if (node.v2) {
    return (
      <AgentHarnessProfile
        node={node}
        options={options}
        canEdit={canEdit}
      />
    );
  }
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

export const readOnlyMonoCls = "w-full resize-none break-all rounded-xs border border-neutral-200 bg-off-white px-2 py-1.5 font-mono text-[11px] leading-[1.5] text-neutral-600 outline-none cursor-default";
export const readOnlyRowCls = "break-all rounded-xs border border-neutral-200 bg-off-white px-2 py-1.5 font-mono text-[11px] leading-[1.5] text-neutral-600";
export const webhookActionButtonCls = "appearance-none rounded-xs border border-mariner bg-panel px-2 py-1 font-mono text-[9px] uppercase tracking-[0.04em] text-mariner disabled:opacity-40";
export const webhookDangerButtonCls = "appearance-none rounded-xs border border-red-300 bg-panel px-2 py-1 font-mono text-[9px] uppercase tracking-[0.04em] text-red-700 disabled:opacity-40";
export const webhookBannerCls = "py-2.5 px-[14px] border-b border-neutral-200 font-body text-xs leading-[1.5]";

const configFieldCompatibility = {
  monoTextareaCls,
  textareaCls,
  triggerRateWindowResetAt,
};

export default configFieldCompatibility;
