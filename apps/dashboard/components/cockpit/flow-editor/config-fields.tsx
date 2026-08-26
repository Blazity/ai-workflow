"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import Link from "next/link";
import type { FlowNodeDef } from "@/lib/flows";
import type {
  PrePrChecksResponse,
  PromptSourceRef,
  RunCancelResponse,
  ScheduleConfigResponse,
  ScheduleEvaluationState,
  ScheduleOccurrenceEntry,
  ScheduleOccurrenceOutcome,
  ScheduleOverlapPolicy,
  SchedulePreset,
  SchedulePreviewRequest,
  SchedulePreviewResponse,
  ScheduleStatus,
  ScheduleWeekday,
  WebhookAuthScheme,
  WebhookDeliveriesResponse,
  WebhookDeliveryLogEntry,
  WebhookDeliveryOutcome,
  WebhookEndpointConfigResponse,
  WebhookEndpointRevivalResponse,
  WebhookRejectionSummaryEntry,
  WebhookRevealResponse,
  WebhookRevokeResponse,
  WebhookRotateResponse,
  WorkflowDataCatalogEntry,
  WorkflowBlockType,
  WorkflowEditorOptions,
  WorkflowParamValue,
} from "@shared/contracts";
import {
  DEFAULT_OPEN_PR_TITLE,
  DEFAULT_PROMPT_NAME_BY_AGENT,
  DEFAULT_WEBHOOK_SIGNATURE_HEADER,
  DEFAULT_WEBHOOK_TIMESTAMP_HEADER,
  DEFAULT_WEBHOOK_TOKEN_HEADER,
} from "@shared/contracts";
import { parseCondition } from "@shared/conditions";
import {
  arrayToLines,
  linesToArray,
  textMatchesLines,
  toggleRequiredArrayValue,
} from "@/lib/workflow-editor/params";
import { describeRepositoryScope } from "@/lib/workflow-editor/repository-scope";
import { readErrorMessage } from "@/lib/api/error-message";
import { Listbox } from "@/components/cockpit/listbox";
import { investigateProviders } from "./blocks";
import { WebhookTestDeliveryModal } from "./webhook-test-delivery-modal";
import { PromptField } from "./prompt-field";
import { RepositoryScopeModal } from "./repository-scope-modal";
import { useRepositoryScopeContext } from "./repository-scope-context";
import { PromptEditor } from "@/components/cockpit/prompt-editor/prompt-editor";
import { WorkflowTextTemplateEditor } from "./workflow-text-template-editor";
import { JsonSchemaEditor } from "./json-schema-editor";
import { usePromptAuthoringContext } from "./prompt-authoring-context";
import { AgentHarnessProfile } from "./agent-harness-profile";

/** The inspector change callback. Widened past WorkflowParamValue so PromptField
 *  can set/clear provenance refs under `promptRefs.<paramKey>` paths too. */
type ConfigChange = (path: string, value: WorkflowParamValue | PromptSourceRef | undefined) => void;

export const inputCls = "h-[26px] px-2 bg-off-white border border-neutral-200 rounded-xs font-mono text-xs text-coal outline-none disabled:opacity-60";
export const textareaCls = "min-h-[64px] px-2 py-1.5 bg-off-white border border-neutral-200 rounded-xs font-body text-xs leading-[1.5] text-coal outline-none resize-y disabled:opacity-60";
export const monoTextareaCls = "min-h-[64px] px-2 py-1.5 bg-off-white border border-neutral-200 rounded-xs font-mono text-xs leading-[1.5] text-coal outline-none resize-y disabled:opacity-60";

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

function OutputSchemaField({
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
function RichTextField({
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

function CanonicalQuestionsField({
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
export function triggerRateWindowResetAt(window: string, now: Date): Date {
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
    fetch(
      `/api/workflow-definitions/${definitionId}/triggers/${encodeURIComponent(nodeId)}/rejections`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as {
          rejectionsToday?: WebhookRejectionSummaryEntry[];
        };
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
function TriggerRateLimitFields({
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
function InvestigateFields({
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

const readOnlyMonoCls = "w-full resize-none break-all rounded-xs border border-neutral-200 bg-off-white px-2 py-1.5 font-mono text-[11px] leading-[1.5] text-neutral-600 outline-none cursor-default";
const readOnlyRowCls = "break-all rounded-xs border border-neutral-200 bg-off-white px-2 py-1.5 font-mono text-[11px] leading-[1.5] text-neutral-600";
const webhookActionButtonCls = "appearance-none rounded-xs border border-mariner bg-panel px-2 py-1 font-mono text-[9px] uppercase tracking-[0.04em] text-mariner disabled:opacity-40";
const webhookDangerButtonCls = "appearance-none rounded-xs border border-red-300 bg-panel px-2 py-1 font-mono text-[9px] uppercase tracking-[0.04em] text-red-700 disabled:opacity-40";
const webhookBannerCls = "py-2.5 px-[14px] border-b border-neutral-200 font-body text-xs leading-[1.5]";

/** The two header defaults live in @shared/contracts so the worker's verifier and
 *  this panel resolve the same name. An empty headerName param means "use the
 *  scheme default", and the endpoint resolves it server-side. */
function defaultWebhookHeader(scheme: WebhookAuthScheme): string {
  return scheme === "shared_token"
    ? DEFAULT_WEBHOOK_TOKEN_HEADER
    : DEFAULT_WEBHOOK_SIGNATURE_HEADER;
}

const WEBHOOK_SCHEME_LABELS: Record<WebhookAuthScheme, string> = {
  hmac_sha256: "HMAC SHA-256 signature",
  shared_token: "Shared token",
};

/** What the stored credential is called for each scheme. hmac signs the body, so
 *  the value is a signing secret; a shared token is the literal value the sender
 *  copies into the header, so calling it a "secret" would understate what it is. */
function webhookSecretNoun(scheme: WebhookAuthScheme): {
  /** Sentence-case field label. */ label: string;
  /** Lower-case noun for inline copy. */ inline: string;
} {
  return scheme === "shared_token"
    ? { label: "Shared token", inline: "shared token" }
    : { label: "Signing secret", inline: "signing secret" };
}

/** Reveal, rotate and revival all hand back a cleartext secret exactly once;
 *  revoke hands back nothing to show. */
type WebhookActionResponse =
  | WebhookRevealResponse
  | WebhookRotateResponse
  | WebhookEndpointRevivalResponse
  | WebhookRevokeResponse;

type WebhookConfirmAction =
  | "reveal"
  | "rotate"
  | "force_rotate"
  | "revoke"
  | "unrevoke";

/** Confirm copy, parameterised by scheme so a shared-token endpoint never calls
 *  its literal header value a "signing secret". */
function webhookConfirmCopy(
  action: WebhookConfirmAction,
  scheme: WebhookAuthScheme,
): { title: string; body: string; confirmLabel: string; danger: boolean } {
  const noun = webhookSecretNoun(scheme);
  const tokenAside =
    scheme === "shared_token"
      ? " It is the literal value senders send in the header."
      : "";
  switch (action) {
    case "reveal":
      return {
        title: `Reveal ${noun.inline}`,
        body: `Revealing the ${noun.inline} is recorded in the audit log with your name.${tokenAside} Copy it, then hide it again.`,
        confirmLabel: "Reveal",
        danger: false,
      };
    case "rotate":
      return {
        title: `Rotate ${noun.inline}`,
        body: `A new ${noun.inline} is issued and shown once. The previous one keeps working for a short window so senders can catch up.`,
        confirmLabel: "Rotate",
        danger: false,
      };
    case "force_rotate":
      return {
        title: "Force a second rotation",
        body: `A rotation is still in flight. Forcing another one ends the previous ${noun.inline} immediately, so any sender still using it starts failing.`,
        confirmLabel: "Force rotate",
        danger: true,
      };
    case "revoke":
      return {
        title: "Revoke endpoint",
        body: "Deliveries to this URL are refused from now on and no run can start from them. You can bring the endpoint back later, with a new secret.",
        confirmLabel: "Revoke",
        danger: true,
      };
    case "unrevoke":
      return {
        title: "Unrevoke endpoint",
        body: `The endpoint starts accepting deliveries again with a NEW ${noun.inline}, shown once. The revoked ${noun.inline} stays dead, so every sender has to be updated.`,
        confirmLabel: "Unrevoke",
        danger: false,
      };
  }
}

const WEBHOOK_OUTCOME_STYLES: Record<WebhookDeliveryOutcome, string> = {
  started: "border-green-300 bg-green-50 text-green-800",
  pending: "border-neutral-300 bg-off-white text-neutral-700",
  coalesced: "border-mariner-200 bg-mariner-100 text-mariner",
  rejected: "border-red-300 bg-red-50 text-red-700",
  error: "border-red-300 bg-red-50 text-red-700",
  test: "border-neutral-300 bg-off-white text-neutral-700",
};

/** One-line cause per refusal reason, so an operator reads why the endpoint said
 *  no without cross-referencing the worker. An unknown reason falls back to the
 *  raw string alone. */
const WEBHOOK_REJECTION_CAUSES: Record<string, string> = {
  decrypt_failed: "encryption key drift, redeploy config, not a sender issue",
  missing_signature: "sender is not sending the signature header (check the header name)",
  invalid_signature: "signature does not match the secret",
  endpoint_disabled: "revoked, or the workflow is disabled",
  rate_limited: "throttled, too many deliveries per minute",
  payload_too_large: "the body is larger than the accepted limit",
  invalid_payload: "the body is not the JSON the endpoint expects",
};

const WEBHOOK_MAPPING_FIELDS: readonly {
  key:
    | "provider"
    | "sourceIdPath"
    | "sourceUrlPath"
    | "customerContextPath"
    | "mapSubject"
    | "mapDescription"
    | "mapRequester"
    | "mapPriority";
  label: string;
  placeholder: string;
}[] = [
  { key: "provider", label: "Support provider (optional)", placeholder: "zendesk or sentry" },
  { key: "sourceIdPath", label: "Source ID mapping", placeholder: "ticket.id" },
  { key: "sourceUrlPath", label: "Source URL mapping", placeholder: "ticket.url" },
  { key: "customerContextPath", label: "Customer context mapping", placeholder: "ticket.requester" },
  { key: "mapSubject", label: "Subject mapping", placeholder: "subject" },
  { key: "mapDescription", label: "Description mapping", placeholder: "description" },
  { key: "mapRequester", label: "Requester mapping", placeholder: "requester" },
  { key: "mapPriority", label: "Priority mapping", placeholder: "priority" },
];

/** Countdown to the instant the replaced secret stops being accepted. Takes the
 *  clock so the copy can be asserted without freezing time. */
export function describeRotationWindow(
  previousExpiresAt: string | null,
  now: number,
): string {
  if (previousExpiresAt === null) return "shortly";
  const remaining = new Date(previousExpiresAt).getTime() - now;
  if (Number.isNaN(remaining)) return "shortly";
  // Beyond a minute in the past this describes an elapsed age ("3 hours ago"),
  // not a countdown: an in-flight webhook rotation window never asks about
  // anything this stale, but a schedule's last run can be weeks old, and this
  // is still the one relative-time formatter, not a second one.
  if (remaining < -60_000) return describeElapsed(-remaining);
  if (remaining <= 0) return "any moment now";
  if (remaining < 60_000) return "in under a minute";
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  // A weekly schedule's next occurrence is well past a day away, and "in 148
  // hours" is not a scale anyone reads at a glance.
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

function describeElapsed(elapsedMs: number): string {
  const minutes = Math.round(elapsedMs / 60_000);
  if (minutes < 1) return "under a minute ago";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Delivery timestamps stay in UTC: an operator comparing the log against a
 *  sender's own records needs one timezone, not the browser's. */
export function formatWebhookInstant(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${parsed.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function WebhookConfirmPanel({
  action,
  scheme,
  busy,
  onCancel,
  onConfirm,
}: {
  action: WebhookConfirmAction;
  scheme: WebhookAuthScheme;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = webhookConfirmCopy(action, scheme);
  return (
    <div className="flex flex-col gap-1.5 py-2.5 px-[14px] border-b border-neutral-200 bg-off-white">
      <div className="font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase">
        {copy.title}
      </div>
      <p className="m-0 font-body text-xs leading-[1.5] text-neutral-700">
        {copy.body}
      </p>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className={copy.danger ? webhookDangerButtonCls : webhookActionButtonCls}
        >
          {busy ? "Working…" : copy.confirmLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="appearance-none border-none bg-transparent p-0 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-600 disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Import a secret the sender itself generated (for example a Sentry Internal
 *  Integration Client Secret), rather than one this endpoint minted. The pasted
 *  value lives only in this panel's own state, is cleared the instant it is
 *  submitted, and is never rendered back or echoed in any response. Scheme
 *  agnostic: whatever the sender signs or sends, this becomes the stored secret. */
function WebhookSetSecretPanel({
  scheme,
  busy,
  onCancel,
  onSubmit,
}: {
  scheme: WebhookAuthScheme;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (secret: string) => void;
}) {
  const [value, setValue] = useState("");
  const noun = webhookSecretNoun(scheme);
  function submit() {
    const secret = value;
    // Drop the pasted value from state before the request resolves, so it never
    // outlives the submit even if the panel lingers on an error.
    setValue("");
    onSubmit(secret);
  }
  return (
    <div className="flex flex-col gap-1.5 py-2.5 px-[14px] border-b border-neutral-200 bg-off-white">
      <div className="font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase">
        Set {noun.inline}
      </div>
      <p className="m-0 font-body text-xs leading-[1.5] text-neutral-700">
        Set the {noun.inline} to a value the sender generates, for example a Sentry
        Internal Integration Client Secret. This replaces the current {noun.inline}{" "}
        immediately.
      </p>
      <input
        type="text"
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        aria-label={`New ${noun.inline} value`}
        placeholder="Paste the sender's secret"
        className={`${inputCls} w-full`}
      />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={busy || value.trim() === ""}
          onClick={submit}
          className={webhookActionButtonCls}
        >
          {busy ? "Working…" : "Set secret"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="appearance-none border-none bg-transparent p-0 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-600 disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The cleartext credential, which exists in the browser only between the
 *  response that produced it and the operator dismissing this block. */
function WebhookSecretReveal({
  secret,
  scheme,
  copied,
  copyError,
  onCopy,
  onDismiss,
}: {
  secret: string;
  scheme: WebhookAuthScheme;
  copied: boolean;
  copyError: boolean;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  const noun = webhookSecretNoun(scheme);
  return (
    <ConfigField
      label={noun.label}
      action={
        <>
          <button
            type="button"
            onClick={onCopy}
            aria-label={`Copy ${noun.inline}`}
            className={webhookActionButtonCls}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={`Hide ${noun.inline}`}
            className={webhookActionButtonCls}
          >
            Hide
          </button>
        </>
      }
    >
      <textarea
        value={secret}
        readOnly
        aria-readonly="true"
        aria-label={`Webhook ${noun.inline}`}
        rows={2}
        className={readOnlyMonoCls}
      />
      {copyError ? (
        <div role="alert" className="font-body text-[11px] leading-[1.5] text-red-700">
          Copy failed, select and copy manually.
        </div>
      ) : (
        <div className="font-body text-[11px] leading-[1.5] text-neutral-600">
          {scheme === "shared_token"
            ? "This is the literal token senders send in the header. "
            : ""}
          Copy it now. Hiding it drops it from this page, and only another reveal
          brings it back.
        </div>
      )}
    </ConfigField>
  );
}

function WebhookAwaitDeployNote({ onReload }: { onReload: () => void }) {
  return (
    <ConfigField
      label="Endpoint"
      action={
        <button type="button" onClick={onReload} className={webhookActionButtonCls}>
          Refresh
        </button>
      }
    >
      <div className="font-body text-xs leading-[1.5] text-neutral-700">
        This trigger has no endpoint yet. Deploy the workflow, then Refresh: its
        URL and secret appear here.
      </div>
    </ConfigField>
  );
}

/** Pure rendering of the server-owned half of the panel, so every lifecycle
 *  state can be asserted without a network or a DOM. */
export function WebhookEndpointSection({
  config,
  loading,
  loadError,
  canEdit,
  busy,
  actionError,
  confirm,
  setSecretOpen,
  secret,
  copied,
  copyError,
  now,
  onCopyUrl,
  onCopySecret,
  onDismissSecret,
  onConfirmRequest,
  onConfirmCancel,
  onConfirmRun,
  onSetSecretOpen,
  onSetSecretCancel,
  onSetSecretSubmit,
  onReload,
}: {
  config: WebhookEndpointConfigResponse | null;
  loading: boolean;
  loadError: string | null;
  canEdit: boolean;
  busy: boolean;
  actionError: string | null;
  confirm: WebhookConfirmAction | null;
  setSecretOpen: boolean;
  secret: string | null;
  copied: "url" | "secret" | null;
  copyError: boolean;
  now: number;
  onCopyUrl: () => void;
  onCopySecret: () => void;
  onDismissSecret: () => void;
  onConfirmRequest: (action: WebhookConfirmAction) => void;
  onConfirmCancel: () => void;
  onConfirmRun: (action: WebhookConfirmAction) => void;
  onSetSecretOpen: () => void;
  onSetSecretCancel: () => void;
  onSetSecretSubmit: (secret: string) => void;
  onReload: () => void;
}) {
  if (loadError !== null) {
    return (
      <ConfigField
        label="Endpoint"
        action={
          <button type="button" onClick={onReload} className={webhookActionButtonCls}>
            Retry
          </button>
        }
      >
        <div role="alert" className="font-body text-xs leading-[1.5] text-red-700">
          {loadError}
        </div>
      </ConfigField>
    );
  }
  // No config at all means the definition was never saved, so it is the same
  // "deploy first" story the server tells for a draft-only node.
  if (config === null) {
    return loading ? (
      <ConfigNote>Loading endpoint…</ConfigNote>
    ) : (
      <WebhookAwaitDeployNote onReload={onReload} />
    );
  }
  if (config.state === "unconfigured") {
    return (
      <ConfigNote>
        Webhook deliveries are switched off for this deployment: it carries no
        WEBHOOK_TRIGGER_ENCRYPTION_KEY, so no endpoint can be issued. Set that
        environment variable and redeploy to turn them on.
      </ConfigNote>
    );
  }
  // "await_deploy" and, defensively, any state that arrived without its row.
  const endpoint = config.endpoint;
  if (endpoint === null) return <WebhookAwaitDeployNote onReload={onReload} />;

  const revoked = config.state === "revoked";
  const inactive = config.state === "inactive";
  const scheme = endpoint.authScheme;
  return (
    <>
      {revoked && (
        <div role="alert" className={`${webhookBannerCls} bg-red-50 text-red-700`}>
          This endpoint is revoked. Every delivery sent to the URL is refused and
          no run can start from it. Unrevoke issues a new {webhookSecretNoun(scheme).inline}.
        </div>
      )}
      {inactive && (
        <div role="alert" className={`${webhookBannerCls} bg-amber-50 text-amber-800`}>
          This endpoint is not receiving: the workflow is disabled or another
          workflow owns the webhook trigger. The URL and secret below still exist,
          but deliveries do not start runs until this workflow is the enabled
          owner again.
        </div>
      )}
      {!revoked && endpoint.hasPendingRotation && (
        <div role="status" className={`${webhookBannerCls} bg-off-white text-neutral-700`}>
          Rotation in flight. The previous secret stops being accepted{" "}
          {describeRotationWindow(endpoint.previousExpiresAt, now)}. Until then a
          delivery signed with it is accepted and shows as verified with previous
          in the log below.
        </div>
      )}
      <ConfigField
        label="Endpoint URL"
        action={
          <button
            type="button"
            onClick={onCopyUrl}
            className={webhookActionButtonCls}
            aria-label="Copy endpoint URL"
          >
            {copied === "url" ? "Copied" : "Copy"}
          </button>
        }
      >
        <textarea
          value={endpoint.url}
          readOnly
          aria-readonly="true"
          aria-label="Webhook endpoint URL"
          rows={2}
          className={readOnlyMonoCls}
        />
      </ConfigField>
      <ConfigField label="Deployed authentication">
        <div className={readOnlyRowCls}>{WEBHOOK_SCHEME_LABELS[scheme]}</div>
      </ConfigField>
      <ConfigField label="Deployed header">
        <div className={readOnlyRowCls}>{endpoint.headerName}</div>
      </ConfigField>
      {endpoint.requireTimestamp && (
        <ConfigField label="Deployed replay protection">
          <div className={readOnlyRowCls}>
            On, timestamp header {endpoint.timestampHeader}, tolerance{" "}
            {endpoint.timestampToleranceSeconds}s
          </div>
        </ConfigField>
      )}
      {secret !== null ? (
        <WebhookSecretReveal
          secret={secret}
          scheme={scheme}
          copied={copied === "secret"}
          copyError={copyError}
          onCopy={onCopySecret}
          onDismiss={onDismissSecret}
        />
      ) : (
        <ConfigField
          label={webhookSecretNoun(scheme).label}
          action={
            !revoked && (
              <button
                type="button"
                disabled={!canEdit || busy}
                onClick={() => onConfirmRequest("reveal")}
                className={webhookActionButtonCls}
                aria-label={`Reveal ${webhookSecretNoun(scheme).inline}`}
              >
                Reveal
              </button>
            )
          }
        >
          <textarea
            value={endpoint.maskedSecret}
            readOnly
            aria-readonly="true"
            aria-label={`Webhook ${webhookSecretNoun(scheme).inline}`}
            rows={2}
            className={readOnlyMonoCls}
          />
        </ConfigField>
      )}
      {confirm !== null && (
        <WebhookConfirmPanel
          action={confirm}
          scheme={scheme}
          busy={busy}
          onCancel={onConfirmCancel}
          onConfirm={() => onConfirmRun(confirm)}
        />
      )}
      {setSecretOpen && (
        <WebhookSetSecretPanel
          scheme={scheme}
          busy={busy}
          onCancel={onSetSecretCancel}
          onSubmit={onSetSecretSubmit}
        />
      )}
      {actionError !== null && (
        <div role="alert" className={`${webhookBannerCls} bg-red-50 text-red-700`}>
          {actionError}
        </div>
      )}
      <div className="flex items-center gap-1.5 py-2.5 px-[14px] border-b border-neutral-200">
        {revoked ? (
          <button
            type="button"
            disabled={!canEdit || busy}
            onClick={() => onConfirmRequest("unrevoke")}
            className={webhookActionButtonCls}
          >
            Unrevoke
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={!canEdit || busy}
              onClick={() => onConfirmRequest("rotate")}
              className={webhookActionButtonCls}
            >
              Rotate
            </button>
            <button
              type="button"
              disabled={!canEdit || busy}
              onClick={onSetSecretOpen}
              className={webhookActionButtonCls}
              aria-label={`Set ${webhookSecretNoun(scheme).inline}`}
            >
              Set secret
            </button>
            <button
              type="button"
              disabled={!canEdit || busy}
              onClick={() => onConfirmRequest("revoke")}
              className={webhookDangerButtonCls}
            >
              Revoke
            </button>
          </>
        )}
      </div>
    </>
  );
}

/** Pure rendering of the delivery log. Refused requests never become deliveries,
 *  so the rejection summary is the only place they are visible at all. */
export function WebhookDeliveriesSection({
  deliveries,
  rejectionsToday,
  loading,
  error,
  canTest,
  onRefresh,
  onTest,
}: {
  deliveries: readonly WebhookDeliveryLogEntry[];
  rejectionsToday: readonly WebhookRejectionSummaryEntry[];
  loading: boolean;
  error: string | null;
  canTest: boolean;
  onRefresh: () => void;
  onTest: () => void;
}) {
  return (
    <ConfigField
      label="Recent deliveries"
      action={
        <>
          <button
            type="button"
            disabled={loading}
            onClick={onRefresh}
            className={webhookActionButtonCls}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            disabled={!canTest}
            onClick={onTest}
            className={webhookActionButtonCls}
            aria-haspopup="dialog"
          >
            Send test
          </button>
        </>
      }
    >
      {rejectionsToday.length > 0 && (
        <div className="rounded-xs border border-red-200 bg-red-50 px-2 py-1.5">
          <div className="font-mono text-[8px] uppercase tracking-[0.05em] text-red-800">
            Refused today
          </div>
          <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
            {rejectionsToday.map((entry) => (
              <li
                key={entry.reason}
                className="list-none font-body text-[11px] leading-[1.35] text-red-800"
              >
                <span className="font-mono">
                  {entry.reason} {entry.count}
                </span>
                {WEBHOOK_REJECTION_CAUSES[entry.reason]
                  ? `: ${WEBHOOK_REJECTION_CAUSES[entry.reason]}`
                  : ""}
              </li>
            ))}
          </ul>
          <div className="mt-1 font-body text-[10px] leading-[1.35] text-red-700">
            This counts refusals before dispatch. It does not include
            dispatch-time rejections, which appear in the delivery log below.
          </div>
        </div>
      )}
      {error !== null ? (
        <div role="alert" className="font-body text-xs leading-[1.5] text-red-700">
          {error}
        </div>
      ) : deliveries.length === 0 ? (
        <div className="font-body text-xs leading-[1.5] text-neutral-600">
          {loading ? "Loading deliveries…" : "No deliveries yet."}
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {deliveries.map((delivery) => (
            <li
              key={delivery.deliveryId}
              className="rounded-xs border border-neutral-200 bg-off-white px-2 py-1.5"
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`rounded-xs border px-1 py-px font-mono text-[8px] uppercase tracking-[0.04em] ${WEBHOOK_OUTCOME_STYLES[delivery.outcome]}`}
                >
                  {delivery.outcome}
                </span>
                <span className="font-mono text-[9px] text-neutral-600">
                  {formatWebhookInstant(delivery.receivedAt)}
                </span>
              </div>
              {delivery.reason !== null && (
                <div className="mt-0.5 break-all font-body text-[11px] leading-[1.4] text-neutral-700">
                  {delivery.reason}
                </div>
              )}
              <div className="mt-0.5 break-all font-mono text-[9px] text-neutral-500">
                {delivery.runId === null ? "no run" : `run ${delivery.runId}`}
                {" · "}
                {delivery.verifiedWith === null
                  ? "not authenticated"
                  : `verified with ${delivery.verifiedWith}`}
              </div>
            </li>
          ))}
        </ul>
      )}
    </ConfigField>
  );
}

/** Server-owned half of the webhook inspector: it fetches the endpoint once per
 *  definition and node, and every mutation is an explicit, confirmed click. */
function WebhookEndpointPanel({
  definitionId,
  nodeId,
  triggerLabel,
  canEdit,
}: {
  definitionId: number | undefined;
  nodeId: string;
  triggerLabel: string;
  canEdit: boolean;
}) {
  const [config, setConfig] = useState<WebhookEndpointConfigResponse | null>(null);
  const [loading, setLoading] = useState(definitionId !== undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<readonly WebhookDeliveryLogEntry[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<WebhookConfirmAction | null>(null);
  const [setSecretOpen, setSetSecretOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState<"url" | "secret" | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const base =
    definitionId === undefined
      ? null
      : `/api/workflow-definitions/${definitionId}/triggers/${encodeURIComponent(nodeId)}/webhook`;

  const loadConfig = useCallback(async () => {
    if (base === null) return;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`${base}/config`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readErrorMessage(response));
      setConfig((await response.json()) as WebhookEndpointConfigResponse);
    } catch (caught) {
      setConfig(null);
      setLoadError(
        caught instanceof Error
          ? caught.message
          : "Unable to load this webhook endpoint.",
      );
    } finally {
      setLoading(false);
    }
  }, [base]);

  const loadDeliveries = useCallback(async () => {
    if (base === null) return;
    setDeliveriesLoading(true);
    setDeliveriesError(null);
    try {
      const response = await fetch(`${base}/deliveries`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readErrorMessage(response));
      const payload = (await response.json()) as WebhookDeliveriesResponse;
      setDeliveries(payload.deliveries);
    } catch (caught) {
      setDeliveries([]);
      setDeliveriesError(
        caught instanceof Error
          ? caught.message
          : "Unable to load recent deliveries.",
      );
    } finally {
      setDeliveriesLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // An endpoint that exists in any lifecycle state has a delivery log worth
  // showing, even a revoked or inactive one (historical rows, refusal counts).
  const live =
    config?.state === "active" ||
    config?.state === "revoked" ||
    config?.state === "inactive";
  useEffect(() => {
    if (live) void loadDeliveries();
  }, [live, loadDeliveries]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  async function copy(field: "url" | "secret", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      setCopyError(false);
      setCopied(field);
      copyTimer.current = setTimeout(() => setCopied(null), 2000);
    } catch {
      // A blocked clipboard (permissions/insecure context) is silent for the URL
      // and mask, which stay on screen. A one-time cleartext secret does not, so
      // there we surface a manual-copy fallback instead of losing it quietly.
      if (field === "secret") setCopyError(true);
    }
  }

  async function run(action: WebhookConfirmAction) {
    if (base === null) return;
    setBusy(true);
    setActionError(null);
    try {
      const path =
        action === "reveal"
          ? "reveal"
          : action === "revoke"
            ? "revoke"
            : action === "unrevoke"
              ? "unrevoke"
              : "rotate";
      const response = await fetch(`${base}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "force_rotate" ? { force: true } : {}),
        cache: "no-store",
      });
      if (response.status === 409 && action === "rotate") {
        setConfirm("force_rotate");
        setActionError(
          "A rotation is already in flight, so the previous secret is still inside its acceptance window.",
        );
        // The snapshot may predate the in-flight rotation, so refresh it to show
        // the pending-rotation banner behind the force prompt.
        await loadConfig();
        return;
      }
      if (!response.ok) throw new Error(await readErrorMessage(response));
      const payload = (await response.json()) as WebhookActionResponse;
      setConfirm(null);
      setCopyError(false);
      if ("secret" in payload) setSecret(payload.secret);
      // Reveal only reads the stored secret; reloading afterward risks a failed
      // fetch wiping the one-time cleartext we just put on screen, so skip it.
      if (action !== "reveal") {
        await loadConfig();
        await loadDeliveries();
      }
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : "This action did not go through.",
      );
    } finally {
      setBusy(false);
    }
  }

  // Import a sender-generated secret. The pasted value only travels through this
  // request body; it is never stored in the panel's own state and the masked
  // config it returns is discarded in favour of a fresh reload, exactly like
  // rotate. On failure the reason surfaces in the shared action-error banner.
  async function runSetSecret(value: string) {
    if (base === null) return;
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch(`${base}/set-secret`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: value }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await readErrorMessage(response));
      setSetSecretOpen(false);
      await loadConfig();
      await loadDeliveries();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : "Setting the secret did not go through.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <WebhookEndpointSection
        config={config}
        loading={loading}
        loadError={loadError}
        canEdit={canEdit}
        busy={busy}
        actionError={actionError}
        confirm={confirm}
        setSecretOpen={setSecretOpen}
        secret={secret}
        copied={copied}
        copyError={copyError}
        now={Date.now()}
        onCopyUrl={() => void copy("url", config?.endpoint?.url ?? "")}
        onCopySecret={() => void copy("secret", secret ?? "")}
        onDismissSecret={() => {
          setSecret(null);
          setCopyError(false);
        }}
        onConfirmRequest={(action) => {
          setActionError(null);
          setSetSecretOpen(false);
          setConfirm(action);
        }}
        onConfirmCancel={() => {
          setConfirm(null);
          setActionError(null);
        }}
        onConfirmRun={(action) => void run(action)}
        onSetSecretOpen={() => {
          setActionError(null);
          setConfirm(null);
          setSetSecretOpen(true);
        }}
        onSetSecretCancel={() => {
          setSetSecretOpen(false);
          setActionError(null);
        }}
        onSetSecretSubmit={(value) => void runSetSecret(value)}
        onReload={() => {
          void loadConfig();
          void loadDeliveries();
        }}
      />
      {live && (
        <WebhookDeliveriesSection
          deliveries={deliveries}
          rejectionsToday={config?.endpoint?.rejectionsToday ?? []}
          loading={deliveriesLoading}
          error={deliveriesError}
          canTest={config?.state === "active"}
          onRefresh={() => {
            void loadConfig();
            void loadDeliveries();
          }}
          onTest={() => setTestOpen(true)}
        />
      )}
      {testOpen && definitionId !== undefined && (
        <WebhookTestDeliveryModal
          definitionId={definitionId}
          nodeId={nodeId}
          triggerLabel={triggerLabel}
          onClose={() => {
            setTestOpen(false);
            // The probe wrote a "test" row, so pull it into the log on close.
            void loadDeliveries();
          }}
        />
      )}
    </>
  );
}

function WebhookTriggerFields({
  node,
  canEdit,
  definitionId,
  onChange,
}: {
  node: FlowNodeDef;
  canEdit: boolean;
  definitionId: number | undefined;
  onChange: ConfigChange;
}) {
  const authScheme: WebhookAuthScheme =
    node.params.authScheme === "shared_token" ? "shared_token" : "hmac_sha256";
  const requireTimestamp = node.params.requireTimestamp === true;
  const toleranceValue =
    typeof node.params.timestampToleranceSeconds === "number"
      ? String(node.params.timestampToleranceSeconds)
      : "";
  // Every one of these keys is optional and the registry supplies the default,
  // so an emptied field has to delete the key rather than store "".
  const write = (key: string) => (value: string) =>
    onChange(`params.${key}`, value.trim() === "" ? undefined : value);
  // The tolerance is a number param: parse it, and delete the key on empty or
  // non-numeric so the registry default (300) stands instead of a bad literal.
  const writeTolerance = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === "") {
      onChange("params.timestampToleranceSeconds", undefined);
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    onChange(
      "params.timestampToleranceSeconds",
      Number.isNaN(parsed) ? undefined : parsed,
    );
  };

  return (
    <>
      <ConfigField label="Authentication">
        <Listbox
          options={[
            { value: "hmac_sha256", label: "HMAC SHA-256 signature" },
            { value: "shared_token", label: "Shared token" },
          ]}
          value={authScheme}
          disabled={!canEdit}
          ariaLabel="Webhook authentication scheme"
          onChange={(value) => onChange("params.authScheme", value)}
        />
      </ConfigField>
      <ConfigField label="Header name">
        <TextInput
          value={str(node.params.headerName)}
          disabled={!canEdit}
          placeholder={defaultWebhookHeader(authScheme)}
          onChange={write("headerName")}
        />
      </ConfigField>
      <ConfigNote>
        HMAC SHA-256 signs the raw request body and the sender presents the hex
        digest in {DEFAULT_WEBHOOK_SIGNATURE_HEADER}. A shared token is compared
        as a constant header value in {DEFAULT_WEBHOOK_TOKEN_HEADER}. Name a
        header only when the sender cannot use that default. Changes to the scheme
        or header apply after you deploy.
      </ConfigNote>
      {authScheme === "hmac_sha256" && (
        <>
          <ConfigField label="Replay protection">
            <CheckboxRow
              label="Require a signed timestamp"
              checked={requireTimestamp}
              disabled={!canEdit}
              onChange={(checked) =>
                onChange("params.requireTimestamp", checked ? true : undefined)
              }
            />
          </ConfigField>
          {requireTimestamp && (
            <>
              <ConfigField label="Timestamp header">
                <TextInput
                  value={str(node.params.timestampHeader)}
                  disabled={!canEdit}
                  placeholder={DEFAULT_WEBHOOK_TIMESTAMP_HEADER}
                  onChange={write("timestampHeader")}
                />
              </ConfigField>
              <ConfigField label="Tolerance (seconds)">
                <TextInput
                  value={toleranceValue}
                  disabled={!canEdit}
                  placeholder="300"
                  onChange={writeTolerance}
                />
              </ConfigField>
              <ConfigNote>
                The sender signs {"{timestamp}.{rawBody}"} (the Unix epoch seconds,
                a literal dot, then the exact body) with HMAC SHA-256 and sends
                that timestamp in the header above (default{" "}
                {DEFAULT_WEBHOOK_TIMESTAMP_HEADER}). A delivery with no timestamp,
                or one older than the tolerance, is refused. Leave this off for
                body-only senders like Sentry that sign just the payload. Changes
                apply after you deploy.
              </ConfigNote>
            </>
          )}
        </>
      )}
      <ConfigField label="Subject path">
        <TextInput
          value={str(node.params.subjectPath)}
          disabled={!canEdit}
          placeholder="e.g. ticket.id"
          onChange={write("subjectPath")}
        />
      </ConfigField>
      {WEBHOOK_MAPPING_FIELDS.map((field) => (
        <ConfigField key={field.key} label={field.label}>
          <TextInput
            value={str(node.params[field.key])}
            disabled={!canEdit}
            placeholder={field.placeholder}
            onChange={write(field.key)}
          />
        </ConfigField>
      ))}
      <ConfigNote>
        Mappings are dot-paths into the delivered JSON body. A path that does not
        resolve becomes an empty string, never a failed delivery. Subject path
        names the external object a delivery is about, so deliveries that share
        one subject coalesce onto the run already handling it. Empty means every
        delivery starts its own run (no coalescing).
      </ConfigNote>
      <TriggerRateLimitFields
        node={node}
        canEdit={canEdit}
        definitionId={definitionId}
        webhook
        onChange={onChange}
      />
      <WebhookEndpointPanel
        definitionId={definitionId}
        nodeId={node.id}
        triggerLabel={node.name ?? node.id}
        canEdit={canEdit}
      />
    </>
  );
}

/**
 * Kinds the schedule preset builder can produce. Mirrors
 * apps/worker/src/schedule-trigger/occurrence.ts SchedulePreset["kind"] exactly.
 * The presets are sugar: they only ever reach the deployed schedule by
 * compiling to a cron expression through the worker's compileSchedulePreset,
 * the same evaluator a hand-written expression goes through, so a preset can
 * never mean something the raw expression field would not.
 */
type SchedulePresetKind = "every-n-minutes" | "every-n-hours" | "daily" | "weekly";

const SCHEDULE_PRESET_KIND_OPTIONS = [
  { value: "every-n-minutes", label: "Every N minutes" },
  { value: "every-n-hours", label: "Every N hours" },
  { value: "daily", label: "Daily at a time" },
  { value: "weekly", label: "Weekly on chosen days" },
];

/** Step choices the preset builder offers. Duplicated from occurrence.ts's own
 *  EVERY_N_MINUTES_STEPS / EVERY_N_HOURS_STEPS rather than imported: the worker
 *  and the dashboard are different packages and this feature must not add a
 *  cron library here to bridge them. Both lists are divisors of an hour or a
 *  day (a fixed mathematical fact, not configuration) and compileSchedulePreset
 *  is still the sole authority that validates a step, this is only display. */
const SCHEDULE_EVERY_N_MINUTES_STEPS = [15, 20, 30, 60] as const;
const SCHEDULE_EVERY_N_HOURS_STEPS = [1, 2, 3, 4, 6, 8, 12, 24] as const;

const SCHEDULE_WEEKDAYS: readonly { value: ScheduleWeekday; label: string }[] = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

const SCHEDULE_OVERLAP_POLICY_OPTIONS: { value: ScheduleOverlapPolicy; label: string }[] = [
  { value: "skip", label: "Skip" },
  { value: "queue", label: "Queue (keep newest)" },
  { value: "allow", label: "Allow concurrent" },
];

const scheduleModeToggleCls = "appearance-none rounded-xs border border-neutral-200 bg-panel px-2 py-1 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-600 disabled:opacity-40";

const SCHEDULE_OUTCOME_STYLES: Record<ScheduleOccurrenceOutcome, string> = {
  started: "border-green-300 bg-green-50 text-green-800",
  skipped_overlap: "border-amber-300 bg-amber-50 text-amber-800",
  skipped_stale: "border-amber-300 bg-amber-50 text-amber-800",
  superseded: "border-mariner-200 bg-mariner-100 text-mariner",
  cancelled: "border-neutral-300 bg-off-white text-neutral-700",
  run_cancelled: "border-neutral-300 bg-neutral-100 text-neutral-800",
  expired: "border-red-300 bg-red-50 text-red-700",
  error: "border-red-300 bg-red-50 text-red-700",
};

/** One line per outcome, so an operator reads what happened without cross
 *  referencing the worker. There is no "skipped_capacity" entry: being at
 *  capacity is not a decision about an occurrence, it stays pending and
 *  carries the reason as an annotation instead (rendered from skipReason). */
const SCHEDULE_OUTCOME_MEANING: Record<ScheduleOccurrenceOutcome, string> = {
  started: "A run started for this occurrence.",
  skipped_overlap:
    "Skipped because the previous run of this schedule was still going. This occurrence will not run and will not be replayed.",
  skipped_stale:
    "Skipped because it was too late past its catch-up grace. This occurrence will not run and will not be replayed.",
  superseded:
    "Replaced by a newer occurrence while it waited: the queue policy keeps only the newest. This occurrence will not run and will not be replayed.",
  cancelled:
    "Cancelled because the schedule was paused while this occurrence was still waiting. It will not run.",
  run_cancelled:
    "Cancelled by an operator while its run was in progress. The run was stopped, and the schedule resumes at the next occurrence.",
  expired: "Abandoned: it waited too long and nothing ever dispatched it.",
  error: "The dispatch attempt for this occurrence failed.",
};

function ScheduleWeekdayToggles({
  value,
  disabled,
  onChange,
}: {
  value: readonly ScheduleWeekday[];
  disabled: boolean;
  onChange: (value: ScheduleWeekday[]) => void;
}) {
  return (
    <div role="group" aria-label="Weekdays" className="flex items-center gap-1">
      {SCHEDULE_WEEKDAYS.map(({ value: day, label }) => {
        const active = value.includes(day);
        return (
          <button
            key={day}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() =>
              onChange(
                active
                  ? value.filter((d) => d !== day)
                  : [...value, day].sort((a, b) => a - b),
              )
            }
            className={`rounded-xs border px-1.5 py-1 font-mono text-[9px] uppercase tracking-[0.04em] disabled:opacity-40 ${
              active
                ? "border-mariner bg-mariner-100 text-mariner"
                : "border-neutral-200 bg-panel text-neutral-600"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

type SchedulePreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ok";
      cron: string;
      timezone: string;
      runs: string[];
      requestKey: string;
      suggestedGraceMinutes: number | null;
    };

/** Renders the computed next-occurrence list, or whatever state the preview is
 *  in. Pure: every branch is a direct function of `preview`, so it is testable
 *  without a fetch. formatWebhookInstant and describeRotationWindow are reused
 *  rather than a second formatter, exactly as the webhook trigger does it. */
/** Shared by every trustState branch below: a validation error must stay
 *  visible no matter what the scheduler is doing. The natural fix loop is
 *  pause, correct the expression, resume, and that loop needs the error
 *  visible in exactly the states that used to hide it: not_evaluated is the
 *  permanent condition of every non-production environment, so hiding
 *  validation there meant the editor was permanently blind to it off
 *  production. */
function SchedulePreviewErrorBanner({ preview }: { preview: SchedulePreviewState }) {
  if (preview.status !== "error") return null;
  return (
    <div role="alert" className="font-body text-xs leading-[1.5] text-red-700">
      {preview.message}
    </div>
  );
}

/** Renders the computed next-occurrence list, or whatever state the preview is
 *  in. Pure: every branch is a direct function of `preview`, so it is testable
 *  without a fetch. formatWebhookInstant and describeRotationWindow are reused
 *  rather than a second formatter, exactly as the webhook trigger does it.
 *
 * `requestKey` is the CURRENT effective request, cron/timezone/preset as they
 * stand right now. When it does not match the request `preview` was computed
 * for, a field changed after the debounce fired and a fresh answer is already
 * in flight, so the numbers on screen are marked stale rather than presented
 * with the same confidence as a fresh answer. */
function renderSchedulePreviewBody(
  preview: SchedulePreviewState,
  requestKey: string,
  now: number,
) {
  if (preview.status === "error") return <SchedulePreviewErrorBanner preview={preview} />;
  if (preview.status !== "ok") {
    return (
      <div className="font-body text-xs leading-[1.5] text-neutral-600">
        {preview.status === "loading" ? "Computing…" : "Enter a schedule to preview it."}
      </div>
    );
  }
  const stale = preview.requestKey !== requestKey;
  if (preview.runs.length === 0) {
    return (
      <div className="font-body text-xs leading-[1.5] text-neutral-600">
        This expression has no upcoming occurrences.
        {stale && " Recalculating for the latest change…"}
      </div>
    );
  }
  return (
    <>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {preview.runs.map((run, index) => (
          <li key={run} className="font-mono text-[11px] text-coal">
            {formatWebhookInstant(run)}
            {index === 0 && (
              <span className="ml-1.5 font-body text-[10px] text-neutral-500">
                ({describeRotationWindow(run, now)})
              </span>
            )}
          </li>
        ))}
      </ul>
      {stale && (
        <div className="mt-1 font-body text-[10px] text-neutral-500">
          Recalculating for the latest change…
        </div>
      )}
    </>
  );
}

/** Two purely client-side states occurrence.ts's ScheduleEvaluationState does
 *  not need to know about, since neither is a fact about the schedule itself:
 *  the status fetch has not resolved yet ("loading"), or it failed and the
 *  operator must still be able to act through that failure ("load_error"). A
 *  fetch in flight must never be presented as "not deployed", and a fetch
 *  that failed must never take Pause and Resume off the screen. */
type ScheduleTrustState = "loading" | "load_error" | ScheduleEvaluationState;

/**
 * The next-occurrences panel, merged with the scheduler's trust state on
 * purpose: requirement is to REPLACE the preview with a warning once the
 * scheduler stops evaluating, not to show both side by side where a confident
 * timestamp list could sit next to a warning and still read as "probably
 * fine". Seven branches, one per state the editor must make unmistakable:
 *   - "loading": the status fetch has not resolved yet. Says so plainly and
 *     offers nothing else: not a draft, not an error, just not answered yet.
 *   - "load_error": the fetch failed. Pause and Resume must still work,
 *     because an operator reaching for the emergency stop during an incident
 *     must not find it gone because a GET failed.
 *   - "draft": not deployed, the preview below is what it WOULD run.
 *   - "evaluating": deployed and healthy, the preview is what it WILL run
 *     from the configuration below; when that configuration differs from
 *     what is actually deployed, a note names the deployed expression too.
 *   - "not_evaluated": deployed but the scheduler has never looked at it or
 *     has stopped, no confident timestamps are shown at all.
 *   - "paused": deliberately not producing occurrences, no timestamps either.
 *   - "revoked": the block is not in the deployed head at all, so nothing is
 *     even trying. Not a failure and must not read as one: the fix is
 *     restoring the block and deploying, which resyncSchedule then clears on
 *     its own, so this state offers a Refresh, never a Pause or a Resume.
 *
 * A validation error from `preview` is shown in every branch, not only the
 * two that already render the preview body: not_evaluated is the permanent
 * condition of every non-production environment, so hiding it there left the
 * pause-fix-resume loop blind everywhere that is not production.
 */
const SCHEDULE_PAUSE_CANCELS_NOTE =
  "Also cancels an occurrence that is already waiting, not just future ones.";
export function ScheduleNextRunsSection({
  trustState,
  schedule,
  preview,
  requestKey,
  draftCron,
  draftTimezone,
  now,
  canEdit,
  busy,
  actionError,
  loadErrorMessage,
  cancelConfirmOpen,
  cancelNotice,
  onPause,
  onResume,
  onReload,
  onCancelRequest,
  onCancelConfirm,
  onCancelDismiss,
}: {
  trustState: ScheduleTrustState;
  schedule: ScheduleStatus | null;
  preview: SchedulePreviewState;
  requestKey: string;
  draftCron: string;
  draftTimezone: string;
  now: number;
  canEdit: boolean;
  busy: boolean;
  actionError: string | null;
  loadErrorMessage: string | null;
  /** Whether the "cancel current run" confirm step is open. There is no live
   *  signal for whether lastStartedRunId is still actually running (see the
   *  block comment on ScheduleStatusPanel), so this only ever gates a second
   *  click, never a claim that a run is in flight. */
  cancelConfirmOpen: boolean;
  /** Result of the last cancel attempt, cleared on the next request. Distinct
   *  from actionError: a cancelled or already_terminal outcome is not a
   *  failure, so it must not render in the same red as one. */
  cancelNotice: string | null;
  onPause: () => void;
  onResume: () => void;
  onReload: () => void;
  onCancelRequest: () => void;
  onCancelConfirm: () => void;
  onCancelDismiss: () => void;
}) {
  if (trustState === "loading") {
    return (
      <ConfigField label="Next occurrences">
        <div className="font-body text-xs leading-[1.5] text-neutral-600">
          Loading schedule status…
        </div>
      </ConfigField>
    );
  }

  if (trustState === "load_error") {
    return (
      <>
        <div role="alert" className={`${webhookBannerCls} bg-red-50 text-red-700`}>
          Unable to load this schedule's status{loadErrorMessage ? `: ${loadErrorMessage}` : "."} Pause
          and Resume still work below: stopping or restarting a schedule must not depend on this read
          succeeding, especially during the kind of incident that makes you reach for them.
        </div>
        <SchedulePreviewErrorBanner preview={preview} />
        {actionError !== null && (
          <div role="alert" className={`${webhookBannerCls} bg-red-50 text-red-700`}>
            {actionError}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5 py-2.5 px-[14px] border-b border-neutral-200">
          <button
            type="button"
            disabled={!canEdit || busy}
            onClick={onPause}
            className={webhookDangerButtonCls}
          >
            Pause
          </button>
          <button
            type="button"
            disabled={!canEdit || busy}
            onClick={onResume}
            className={webhookActionButtonCls}
          >
            Resume
          </button>
          <button type="button" onClick={onReload} className={webhookActionButtonCls}>
            Retry
          </button>
        </div>
      </>
    );
  }

  if (trustState === "not_evaluated") {
    return (
      <>
        <div role="alert" className={`${webhookBannerCls} bg-amber-50 text-amber-800`}>
          {schedule?.lastEvaluatedAt
            ? `The scheduler has not evaluated this schedule in this environment since ${formatWebhookInstant(schedule.lastEvaluatedAt)}. `
            : "The scheduler has never evaluated this schedule in this environment. "}
          The platform cron that drives it only runs on production deployments, so on
          any other environment it may never fire.
        </div>
        <SchedulePreviewErrorBanner preview={preview} />
        {actionError !== null && (
          <div role="alert" className={`${webhookBannerCls} bg-red-50 text-red-700`}>
            {actionError}
          </div>
        )}
        <div className="flex items-center gap-1.5 py-2.5 px-[14px] border-b border-neutral-200">
          <button
            type="button"
            disabled={!canEdit || busy}
            onClick={onPause}
            className={webhookDangerButtonCls}
          >
            Pause
          </button>
          <span className="font-body text-[10px] text-neutral-500">{SCHEDULE_PAUSE_CANCELS_NOTE}</span>
        </div>
      </>
    );
  }

  if (trustState === "revoked") {
    return (
      <>
        <div role="status" className={`${webhookBannerCls} bg-off-white text-neutral-700`}>
          This block's schedule is revoked because the block is not in the deployed
          workflow. It is not a failure and nothing is trying to run it: restore the
          block and deploy to pick the schedule back up automatically, paused if it
          was paused before.
        </div>
        <SchedulePreviewErrorBanner preview={preview} />
        <div className="flex items-center gap-1.5 py-2.5 px-[14px] border-b border-neutral-200">
          <button type="button" onClick={onReload} className={webhookActionButtonCls}>
            Refresh
          </button>
        </div>
      </>
    );
  }

  if (trustState === "paused") {
    return (
      <>
        <div role="status" className={`${webhookBannerCls} bg-off-white text-neutral-700`}>
          Paused{schedule?.pausedAt ? ` since ${formatWebhookInstant(schedule.pausedAt)}` : ""}.
          No occurrence runs while paused. Resuming does not replay the whole time
          it was paused: only an occurrence that still falls inside the schedule's
          catch-up grace is caught up, anything older is skipped as stale, the same
          as after a scheduler outage of that length.
        </div>
        <SchedulePreviewErrorBanner preview={preview} />
        {actionError !== null && (
          <div role="alert" className={`${webhookBannerCls} bg-red-50 text-red-700`}>
            {actionError}
          </div>
        )}
        <div className="flex items-center gap-1.5 py-2.5 px-[14px] border-b border-neutral-200">
          <button
            type="button"
            disabled={!canEdit || busy}
            onClick={onResume}
            className={webhookActionButtonCls}
          >
            Resume
          </button>
        </div>
      </>
    );
  }

  const deploymentDiffers =
    trustState === "evaluating" &&
    schedule !== null &&
    (schedule.cron !== draftCron || schedule.timezone !== draftTimezone);

  return (
    <ConfigField
      label="Next occurrences"
      action={
        <button type="button" onClick={onReload} className={webhookActionButtonCls}>
          Refresh
        </button>
      }
    >
      {trustState === "draft" && (
        <div className="mb-1 font-body text-[11px] leading-[1.4] text-neutral-600">
          This schedule is not deployed yet. Deploy the workflow, then Refresh, to see
          its live status. Meanwhile, here is what the configuration below would run:
        </div>
      )}
      {deploymentDiffers && schedule !== null && (
        <div className="mb-1 font-body text-[11px] leading-[1.4] text-neutral-600">
          This preview reflects the configuration below, which differs from what
          is deployed. The live block still runs{" "}
          <span className="font-mono">{schedule.cron}</span> in {schedule.timezone}
          {" "}until you deploy this change.
        </div>
      )}
      {renderSchedulePreviewBody(preview, requestKey, now)}
      {trustState === "evaluating" && schedule?.lastEvaluatedAt && (
        <div className="mt-1 font-mono text-[9px] text-neutral-500">
          Scheduler last checked {formatWebhookInstant(schedule.lastEvaluatedAt)}.
        </div>
      )}
      {actionError !== null && (
        <div role="alert" className="mt-1 font-body text-[11px] leading-[1.5] text-red-700">
          {actionError}
        </div>
      )}
      {trustState === "evaluating" && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            type="button"
            disabled={!canEdit || busy}
            onClick={onPause}
            className={webhookDangerButtonCls}
          >
            Pause
          </button>
          <span className="font-body text-[10px] text-neutral-500">{SCHEDULE_PAUSE_CANCELS_NOTE}</span>
        </div>
      )}
      {/* lastStartedRunId is the schedule's last-started run, kept in the ledger
       *  forever, not a live "still running" flag: there is no such signal on
       *  ScheduleStatus. So this control is offered whenever one exists, and a
       *  stale click (the run already finished) is answered honestly by the
       *  endpoint's already_terminal outcome below rather than guessed at here. */}
      {trustState === "evaluating" && schedule?.lastStartedRunId && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {cancelConfirmOpen ? (
            <div className="flex flex-col gap-1.5 rounded-xs border border-neutral-200 bg-off-white p-2">
              <p className="m-0 font-body text-xs leading-[1.5] text-neutral-700">
                Cancels run {schedule.lastStartedRunId} if it is still running: the
                subject is released and this occurrence settles as run cancelled.
                The schedule keeps running, starting clean at its next occurrence.
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={onCancelConfirm}
                  className={webhookDangerButtonCls}
                >
                  {busy ? "Working…" : "Cancel this run"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onCancelDismiss}
                  className="appearance-none border-none bg-transparent p-0 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-600 disabled:opacity-40"
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={!canEdit || busy}
              onClick={onCancelRequest}
              className={`${webhookDangerButtonCls} self-start`}
            >
              Cancel current run
            </button>
          )}
          {cancelNotice !== null && (
            <div role="status" className="font-body text-[11px] leading-[1.5] text-neutral-700">
              {cancelNotice}
            </div>
          )}
        </div>
      )}
    </ConfigField>
  );
}

/** A pending row may carry an annotation about why it has not run yet instead
 *  of a decision: none (freshly admitted), "at_capacity" (the shared run pool
 *  is full, recordOccurrenceAtCapacity), or a failed attempt (outcome "error"
 *  while still pending, so the drain will retry it). None of these settle the
 *  occurrence, which is why they render neutral or warning, never the
 *  error-red a genuinely settled outcome gets: waiting for capacity is normal
 *  operation, since the run pool is shared with the human ticket queue. */
function schedulePendingChip(occurrence: ScheduleOccurrenceEntry): { label: string; cls: string } {
  if (occurrence.skipReason === "at_capacity") {
    return { label: "waiting", cls: "border-amber-300 bg-amber-50 text-amber-800" };
  }
  if (occurrence.outcome === "error") {
    return { label: "retrying", cls: "border-amber-300 bg-amber-50 text-amber-800" };
  }
  return { label: "pending", cls: "border-neutral-300 bg-off-white text-neutral-700" };
}

/** Escalation thresholds for a pending annotation's copy: past these, "normal
 *  operation" no longer reads true and the copy should point at the logs
 *  instead, since attempt_count is the only thing that distinguishes "waited
 *  once" from "waited a dozen times" (see occurrence-store.ts's own note on
 *  it). Capacity waits are routine under load, so its floor is higher than a
 *  dispatch error's, which is worth a look sooner. */
const SCHEDULE_CAPACITY_ESCALATION_ATTEMPTS = 5;
const SCHEDULE_ERROR_ESCALATION_ATTEMPTS = 3;

function schedulePendingMeaning(occurrence: ScheduleOccurrenceEntry): string {
  const attempts = occurrence.attemptCount;
  const attemptSuffix = attempts > 1 ? `, attempt ${attempts}` : "";
  if (occurrence.skipReason === "at_capacity") {
    if (attempts > SCHEDULE_CAPACITY_ESCALATION_ATTEMPTS) {
      return `Waiting for capacity${attemptSuffix}. That is far more attempts than a normal wait: check the worker logs for this schedule.`;
    }
    return `Waiting for capacity${attemptSuffix}. The run pool is shared with the ticket queue, so this is expected under load.`;
  }
  if (occurrence.outcome === "error") {
    if (attempts > SCHEDULE_ERROR_ESCALATION_ATTEMPTS) {
      return `A dispatch attempt failed and will be retried${attemptSuffix}. Repeated failures are worth checking the worker logs for.`;
    }
    return `A dispatch attempt failed and will be retried${attemptSuffix}.`;
  }
  return "Admitted, waiting to be dispatched.";
}

/** The wording for a settled occurrence, which for skipped_overlap depends on
 *  what actually blocked it. The ledger has two producers of that outcome and
 *  they mean different things: the dispatcher settles an occurrence whose
 *  subject a started run holds, naming that run, while acceptOccurrence inserts
 *  an occurrence already settled behind one that was merely still waiting, with
 *  no run to name. Telling an operator "the previous run was still going" for
 *  the second sends them looking for a run that never existed, in the one panel
 *  they open to find out what went wrong. */
function scheduleOutcomeMeaning(occurrence: ScheduleOccurrenceEntry): string {
  if (occurrence.outcome === "skipped_overlap" && occurrence.blockingRunId === null) {
    // A third producer, and the reason column is the only thing that separates
    // it: the dispatcher settles an occurrence its trigger's rate limit refused,
    // which has nothing to do with overlap. Saying "another occurrence was
    // waiting" here would send the operator hunting for a queue that is empty.
    if (occurrence.skipReason === "rate_limited") {
      return "Skipped because this trigger's rate limit for the current window was already spent. This occurrence will not run and will not be replayed; the trigger's rejection counter above records it.";
    }
    return "Skipped because another occurrence of this schedule was already waiting its turn. This occurrence will not run and will not be replayed.";
  }
  return SCHEDULE_OUTCOME_MEANING[occurrence.outcome ?? "error"];
}

/** Human labels for a settled outcome's chip, so an operator never has to read
 *  a raw enum value next to a pending row's already-human "waiting" or
 *  "retrying". Deliberately short: the sentence below each chip carries the
 *  actual meaning. */
const SCHEDULE_OUTCOME_CHIP_LABELS: Record<ScheduleOccurrenceOutcome, string> = {
  started: "started",
  skipped_overlap: "skipped",
  skipped_stale: "skipped",
  superseded: "replaced",
  cancelled: "cancelled",
  run_cancelled: "run cancelled",
  expired: "abandoned",
  error: "failed",
};

/** How many of this schedule's own periods "Last run" may age past before it
 *  is highlighted rather than read as routine. A daily schedule silent for
 *  three days is exactly the state that must not look healthy. */
const SCHEDULE_STALE_LAST_RUN_PERIODS = 3;

/** Pure rendering of the occurrence ledger, mirroring WebhookDeliveriesSection:
 *  instant, outcome chip, its meaning, and whatever detail that outcome
 *  carries. A skip shows the run blocking it, so an operator can see which run
 *  is holding the schedule; a started occurrence links its run; a non-zero
 *  dropped_count is always shown, since silently dropping a backlog is exactly
 *  what this ledger exists to make visible, and a capped count reads "at least
 *  N" rather than a bare N, since the evaluator deliberately stopped counting
 *  past its cap and the UI must not invent the precision back. There is no raw
 *  skipReason paragraph: for a settled row it duplicates the meaning sentence
 *  above it without adding anything, and for a pending one it is already
 *  folded into that sentence ("waiting for capacity", "will be retried").
 *
 * lastRun renders last_started_occurrence_at and last_started_run_id from the
 * schedule row, never the evaluation watermark (an internal engine cursor):
 * those two are the only pair that survive the ledger's retention window, so
 * they are what "last run" stands on. Its age is relative and highlighted
 * once it passes a few of the schedule's own periods, so "three minutes ago"
 * and "three weeks ago" cannot read identically; periodMs is null (and the
 * highlight never fires) when there is nothing to compare the age against. */
export function ScheduleOccurrenceHistorySection({
  lastRun,
  now,
  periodMs,
  occurrences,
  loading,
  error,
  onRefresh,
}: {
  lastRun: { occurrenceAt: string; runId: string } | null;
  now: number;
  periodMs: number | null;
  occurrences: readonly ScheduleOccurrenceEntry[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const lastRunAgeMs = lastRun ? now - new Date(lastRun.occurrenceAt).getTime() : null;
  const lastRunIsStale =
    lastRunAgeMs !== null &&
    periodMs !== null &&
    lastRunAgeMs > periodMs * SCHEDULE_STALE_LAST_RUN_PERIODS;
  const startedCount = occurrences.filter((occurrence) => occurrence.outcome === "started").length;

  return (
    <ConfigField
      label="Recent occurrences"
      action={
        <button
          type="button"
          disabled={loading}
          onClick={onRefresh}
          className={webhookActionButtonCls}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      }
    >
      <div
        className={`mb-1 font-body text-[11px] leading-[1.4] ${lastRunIsStale ? "text-amber-800" : "text-neutral-600"}`}
      >
        {lastRun ? (
          <>
            Last run {formatWebhookInstant(lastRun.occurrenceAt)} (
            {describeRotationWindow(lastRun.occurrenceAt, now)}){" · "}
            <Link
              href={`/trace/${encodeURIComponent(lastRun.runId)}`}
              className="text-mariner underline"
            >
              run {lastRun.runId}
            </Link>
            {lastRunIsStale && ", well past this schedule's usual period"}
          </>
        ) : (
          "No run yet."
        )}
      </div>
      {occurrences.length > 0 && (
        <div className="mb-1.5 font-body text-[11px] leading-[1.4] text-neutral-600">
          {startedCount} of {occurrences.length} recent occurrence{occurrences.length === 1 ? "" : "s"}{" "}
          started.
        </div>
      )}
      {error !== null ? (
        <div role="alert" className="font-body text-xs leading-[1.5] text-red-700">
          {error}
        </div>
      ) : occurrences.length === 0 ? (
        <div className="font-body text-xs leading-[1.5] text-neutral-600">
          {loading ? "Loading occurrences…" : "No occurrences yet."}
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {occurrences.map((occurrence) => {
            const pendingChip = occurrence.pending ? schedulePendingChip(occurrence) : null;
            const chipLabel = pendingChip
              ? pendingChip.label
              : SCHEDULE_OUTCOME_CHIP_LABELS[occurrence.outcome ?? "error"];
            const chipCls = pendingChip
              ? pendingChip.cls
              : SCHEDULE_OUTCOME_STYLES[occurrence.outcome ?? "error"];
            const meaning = occurrence.pending
              ? schedulePendingMeaning(occurrence)
              : scheduleOutcomeMeaning(occurrence);
            return (
              <li
                key={occurrence.occurrenceAt}
                className="rounded-xs border border-neutral-200 bg-off-white px-2 py-1.5"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`rounded-xs border px-1 py-px font-mono text-[8px] uppercase tracking-[0.04em] ${chipCls}`}
                  >
                    {chipLabel}
                  </span>
                  <span className="font-mono text-[9px] text-neutral-600">
                    {formatWebhookInstant(occurrence.occurrenceAt)}
                  </span>
                </div>
                <div className="mt-0.5 font-body text-[11px] leading-[1.4] text-neutral-700">
                  {meaning}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1 break-all font-mono text-[9px] text-neutral-500">
                  {occurrence.runId !== null && (
                    <Link href={`/trace/${encodeURIComponent(occurrence.runId)}`} className="text-mariner underline">
                      run {occurrence.runId}
                    </Link>
                  )}
                  {occurrence.blockingRunId !== null && (
                    <span>
                      blocked by{" "}
                      <Link
                        href={`/trace/${encodeURIComponent(occurrence.blockingRunId)}`}
                        className="text-mariner underline"
                      >
                        run {occurrence.blockingRunId}
                      </Link>
                    </span>
                  )}
                  {occurrence.droppedCount > 0 && (
                    <span>
                      dropped {occurrence.droppedCountCapped ? "at least " : ""}
                      {occurrence.droppedCount} earlier occurrence
                      {occurrence.droppedCount === 1 ? "" : "s"}
                    </span>
                  )}
                  {!occurrence.pending && occurrence.attemptCount > 1 && (
                    <span>{occurrence.attemptCount} attempts</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </ConfigField>
  );
}

/** Server-owned half of the schedule inspector: status, pause/resume, and the
 *  occurrence ledger. It fetches config.get once per definition and node,
 *  mutations are explicit clicks, and it never carries its own cron logic, the
 *  live preview it renders (via ScheduleNextRunsSection) is computed by the
 *  parent from the worker's preview route. Pause and Resume are reachable
 *  through every state this panel can be in, including a failed config load:
 *  an operator reaching for the emergency stop during an incident must not
 *  find it gone because a GET failed. */
function ScheduleStatusPanel({
  definitionId,
  nodeId,
  canEdit,
  draftCron,
  draftTimezone,
  preview,
  requestKey,
}: {
  definitionId: number | undefined;
  nodeId: string;
  canEdit: boolean;
  draftCron: string;
  draftTimezone: string;
  preview: SchedulePreviewState;
  requestKey: string;
}) {
  const [config, setConfig] = useState<ScheduleConfigResponse | null>(null);
  const [loading, setLoading] = useState(definitionId !== undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);

  const base =
    definitionId === undefined
      ? null
      : `/api/workflow-definitions/${definitionId}/triggers/${encodeURIComponent(nodeId)}/schedule`;

  const loadConfig = useCallback(async () => {
    if (base === null) return;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`${base}/config`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readErrorMessage(response));
      setConfig((await response.json()) as ScheduleConfigResponse);
    } catch (caught) {
      setConfig(null);
      setLoadError(
        caught instanceof Error ? caught.message : "Unable to load this schedule.",
      );
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  async function run(action: "pause" | "resume") {
    if (base === null) return;
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch(`${base}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        cache: "no-store",
      });
      if (response.status === 403) {
        // readErrorMessage would otherwise surface whatever the proxy's own
        // 403 body happens to contain, which is not guaranteed to mention
        // permissions at all: name the reason directly instead.
        setActionError("You do not have permission to pause or resume this schedule.");
        return;
      }
      if (!response.ok) throw new Error(await readErrorMessage(response));
      await loadConfig();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : "This action did not go through.",
      );
    } finally {
      setBusy(false);
    }
  }

  function requestCancelRun() {
    setActionError(null);
    setCancelNotice(null);
    setCancelConfirmOpen(true);
  }

  function dismissCancelRun() {
    // Clear the last attempt's feedback too, mirroring requestCancelRun: backing
    // out of an unconfirmed/failed cancel must not leave a stale banner with
    // nothing left to retry.
    setActionError(null);
    setCancelNotice(null);
    setCancelConfirmOpen(false);
  }

  // Success here is decided by switching on `outcome`, never on response.ok:
  // already_terminal is still a 200, and it must not read as a fresh cancel
  // just because the request went through.
  async function cancelRun() {
    const runId = config?.schedule?.lastStartedRunId;
    if (!runId) return;
    setBusy(true);
    setActionError(null);
    setCancelNotice(null);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        cache: "no-store",
      });
      if (response.status === 403) {
        setActionError("You do not have permission to cancel this run.");
        return;
      }
      if (response.status === 404) {
        setActionError("This run could not be found.");
        return;
      }
      // 409 still carries a typed body ({ outcome: "unconfirmed" }), so it must
      // reach the switch below rather than being thrown here as a generic
      // failure.
      if (!response.ok && response.status !== 409) {
        throw new Error(await readErrorMessage(response));
      }
      const body = (await response.json()) as RunCancelResponse;
      switch (body.outcome) {
        case "cancelled":
          setCancelNotice("Run cancelled. The schedule starts clean at its next occurrence.");
          setCancelConfirmOpen(false);
          await loadConfig();
          break;
        case "already_terminal":
          setCancelNotice("This run already ended, nothing to cancel.");
          setCancelConfirmOpen(false);
          await loadConfig();
          break;
        case "unconfirmed":
          setActionError("The cancel could not be confirmed. Try again.");
          break;
      }
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : "This action did not go through.",
      );
    } finally {
      setBusy(false);
    }
  }

  const trustState: ScheduleTrustState =
    loadError !== null ? "load_error" : config === null ? "loading" : config.state;
  const live = config !== null && config.state !== "draft";
  // The server's clock, not the browser's: a staleness read must not depend
  // on whether the operator's laptop is off by a few minutes, which is
  // exactly the state this whole feature exists to report truthfully. Only
  // falls back to the local clock before the first response ever lands.
  const now = config?.schedule?.serverNow ? new Date(config.schedule.serverNow).getTime() : Date.now();
  // This schedule's own period, from the live preview's first two occurrences,
  // so "Last run" can be judged against it rather than an arbitrary constant.
  const periodMs =
    preview.status === "ok" && preview.runs.length >= 2
      ? new Date(preview.runs[1]!).getTime() - new Date(preview.runs[0]!).getTime()
      : null;

  return (
    <>
      <ScheduleNextRunsSection
        trustState={trustState}
        schedule={config?.schedule ?? null}
        preview={preview}
        requestKey={requestKey}
        draftCron={draftCron}
        draftTimezone={draftTimezone}
        now={now}
        canEdit={canEdit}
        busy={busy}
        actionError={actionError}
        loadErrorMessage={loadError}
        cancelConfirmOpen={cancelConfirmOpen}
        cancelNotice={cancelNotice}
        onPause={() => void run("pause")}
        onResume={() => void run("resume")}
        onReload={() => void loadConfig()}
        onCancelRequest={requestCancelRun}
        onCancelConfirm={() => void cancelRun()}
        onCancelDismiss={dismissCancelRun}
      />
      {live && (
        <ScheduleOccurrenceHistorySection
          lastRun={
            config?.schedule?.lastStartedOccurrenceAt && config.schedule.lastStartedRunId
              ? {
                  occurrenceAt: config.schedule.lastStartedOccurrenceAt,
                  runId: config.schedule.lastStartedRunId,
                }
              : null
          }
          now={now}
          periodMs={periodMs}
          occurrences={config?.occurrences ?? []}
          loading={loading}
          error={null}
          onRefresh={() => void loadConfig()}
        />
      )}
    </>
  );
}

/** Mirrors occurrence.ts's INTERVAL_PRESET_TIMEZONE. Named to match rather
 *  than imported: the worker and the dashboard are different packages, and
 *  this feature must not bridge them with a shared cron-adjacent module, the
 *  same reason the step-list constants above are copied, not imported. */
const SCHEDULE_INTERVAL_PRESET_TIMEZONE = "UTC";

/**
 * The preset builder plus its debounced live preview, extracted out of
 * ScheduleTriggerFields into its own unit the way WebhookEndpointPanel holds
 * the webhook trigger's own server-owned half. Owns everything the builder
 * needs: which mode and preset fields are selected, the remembered timezone
 * that survives an interval preset's override (see the block comment above
 * reconcileTimezoneForPreset), and the preview fetch, and renders the
 * "Schedule" and "Timezone" fields plus the embedded ScheduleStatusPanel.
 */
function ScheduleCronBuilder({
  node,
  canEdit,
  definitionId,
  onChange,
  onPreviewChange,
}: {
  node: FlowNodeDef;
  canEdit: boolean;
  definitionId: number | undefined;
  onChange: ConfigChange;
  /** Reports the latest preview state upward so a sibling field (catch-up
   *  grace) can offer suggestedGraceMinutes as a suggestion, without lifting
   *  the fetch itself out of this component. */
  onPreviewChange?: (preview: SchedulePreviewState) => void;
}) {
  const cron = str(node.params.cron);
  const timezone = str(node.params.timezone) || SCHEDULE_INTERVAL_PRESET_TIMEZONE;

  const [builderMode, setBuilderMode] = useState<"custom" | "preset">("custom");
  const [presetKind, setPresetKind] = useState<SchedulePresetKind>("every-n-minutes");
  const [presetMinutes, setPresetMinutes] = useState<number>(15);
  const [presetHours, setPresetHours] = useState<number>(1);
  const [presetHour, setPresetHour] = useState<number>(9);
  const [presetMinute, setPresetMinute] = useState<number>(0);
  const [presetWeekdays, setPresetWeekdays] = useState<ScheduleWeekday[]>([1]);

  // A1: the timezone the operator last typed or confirmed themselves, kept
  // beside the authored one rather than instead of it. An interval preset's
  // Apply overwrites params.timezone with UTC (see presetIgnoresTimezone
  // below) without ever touching this, which is what makes it possible to
  // give the zone back when the operator later switches to a clock-anchored
  // preset. Initialised from whatever is authored at mount: at that instant
  // there is no evidence it is a leftover override, so treating it as the
  // operator's own choice is correct, not a guess.
  const [rememberedTimezone, setRememberedTimezone] = useState<string | null>(
    () => str(node.params.timezone) || SCHEDULE_INTERVAL_PRESET_TIMEZONE,
  );
  const [timezoneNeedsConfirmation, setTimezoneNeedsConfirmation] = useState(false);
  const [timezoneRestoredNotice, setTimezoneRestoredNotice] = useState<string | null>(null);

  let presetWire: SchedulePreset;
  switch (presetKind) {
    case "every-n-minutes":
      presetWire = { kind: "every-n-minutes", minutes: presetMinutes };
      break;
    case "every-n-hours":
      presetWire = { kind: "every-n-hours", hours: presetHours };
      break;
    case "daily":
      presetWire = { kind: "daily", hour: presetHour, minute: presetMinute };
      break;
    case "weekly":
      presetWire = { kind: "weekly", weekdays: presetWeekdays, hour: presetHour, minute: presetMinute };
      break;
  }

  const previewRequest: SchedulePreviewRequest =
    builderMode === "preset"
      ? { source: "preset", preset: presetWire, timezone }
      : { source: "cron", cron, timezone };
  const requestKey = JSON.stringify(previewRequest);

  // Mirrors occurrence.ts's own rule (compileSchedulePreset / INTERVAL_PRESET_TIMEZONE):
  // "every N minutes" and "every N hours" below a full day have no clock
  // meaning, an interval is the same interval in any zone, so the worker
  // always compiles them in UTC regardless of the timezone field. Every 24
  // hours is daily at midnight, a clock-anchored preset, and keeps the zone
  // below like "daily" and "weekly" do.
  function ignoresTimezone(kind: SchedulePresetKind, hours: number): boolean {
    return kind === "every-n-minutes" || (kind === "every-n-hours" && hours !== 24);
  }
  const presetIgnoresTimezone = builderMode === "preset" && ignoresTimezone(presetKind, presetHours);

  /**
   * A1's fix: switching TO a clock-anchored preset (kind or step change) must
   * not silently keep whatever an earlier interval preset's Apply forced the
   * timezone field to. Three outcomes:
   *   - moving to (or staying on) an interval kind: nothing to reconcile, and
   *     any pending confirmation is stale, drop it;
   *   - the authored zone already matches what is remembered: nothing was
   *     overridden, leave it alone;
   *   - it does not match: something overwrote it (only Apply-for-an-interval-
   *     preset ever does), so restore the remembered zone and say so, or, if
   *     there is nothing remembered to restore (only reachable if this
   *     component remounted between the override and this switch, losing the
   *     in-memory value), blank the field and refuse to apply until the
   *     operator states one explicitly rather than silently keep UTC.
   */
  function reconcileTimezoneForPreset(kind: SchedulePresetKind, hours: number) {
    if (ignoresTimezone(kind, hours)) {
      setTimezoneNeedsConfirmation(false);
      setTimezoneRestoredNotice(null);
      return;
    }
    const authored = str(node.params.timezone) || SCHEDULE_INTERVAL_PRESET_TIMEZONE;
    if (authored === rememberedTimezone) {
      setTimezoneRestoredNotice(null);
      return;
    }
    if (rememberedTimezone === null) {
      setTimezoneNeedsConfirmation(true);
      setTimezoneRestoredNotice(null);
      return;
    }
    onChange("params.timezone", rememberedTimezone);
    setTimezoneNeedsConfirmation(false);
    setTimezoneRestoredNotice(rememberedTimezone);
  }

  function writeTimezone(value: string) {
    const trimmed = value.trim();
    const next = trimmed === "" ? SCHEDULE_INTERVAL_PRESET_TIMEZONE : value;
    onChange("params.timezone", next);
    setRememberedTimezone(next);
    setTimezoneNeedsConfirmation(false);
    setTimezoneRestoredNotice(null);
  }

  const [preview, setPreview] = useState<SchedulePreviewState>({ status: "idle" });
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewFirstRunRef = useRef(true);

  useEffect(
    () => () => {
      previewAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    onPreviewChange?.(preview);
  }, [preview, onPreviewChange]);

  // Debounced like the workflow validator (5s): fires immediately on the first
  // render of this node so the panel is not blank on open, then waits out a
  // quiet period on every later change instead of firing per keystroke.
  useEffect(() => {
    if (definitionId === undefined) {
      setPreview({ status: "idle" });
      return;
    }
    const delayMs = previewFirstRunRef.current ? 0 : 5_000;
    previewFirstRunRef.current = false;

    async function runPreview() {
      previewAbortRef.current?.abort();
      const controller = new AbortController();
      previewAbortRef.current = controller;
      setPreview({ status: "loading" });
      try {
        const response = await fetch(
          `/api/workflow-definitions/${definitionId}/triggers/${encodeURIComponent(node.id)}/schedule/preview`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: requestKey,
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error(await readErrorMessage(response));
        const payload = (await response.json()) as SchedulePreviewResponse;
        if (controller.signal.aborted) return;
        if (payload.ok) {
          setPreview({
            status: "ok",
            cron: payload.cron,
            timezone: payload.timezone,
            runs: payload.runs,
            requestKey,
            suggestedGraceMinutes: payload.suggestedGraceMinutes,
          });
        } else {
          setPreview({ status: "error", message: payload.problem.message });
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        setPreview({
          status: "error",
          message: caught instanceof Error ? caught.message : "Unable to compute the preview.",
        });
      }
    }

    const timer = setTimeout(() => void runPreview(), delayMs);
    return () => clearTimeout(timer);
  }, [definitionId, node.id, requestKey]);

  return (
    <>
      <ConfigField
        label="Schedule"
        action={
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => setBuilderMode("custom")}
              className={builderMode === "custom" ? webhookActionButtonCls : scheduleModeToggleCls}
            >
              Custom
            </button>
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => setBuilderMode("preset")}
              className={builderMode === "preset" ? webhookActionButtonCls : scheduleModeToggleCls}
            >
              Preset
            </button>
          </div>
        }
      >
        {builderMode === "custom" ? (
          <TextInput
            value={cron}
            disabled={!canEdit}
            placeholder="0 9 * * *"
            onChange={(v) => onChange("params.cron", v)}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <Listbox
              options={SCHEDULE_PRESET_KIND_OPTIONS}
              value={presetKind}
              disabled={!canEdit}
              ariaLabel="Preset kind"
              onChange={(v) => {
                const kind = v as SchedulePresetKind;
                setPresetKind(kind);
                reconcileTimezoneForPreset(kind, presetHours);
              }}
            />
            {presetKind === "every-n-minutes" && (
              <Listbox
                options={SCHEDULE_EVERY_N_MINUTES_STEPS.map((m) => ({
                  value: String(m),
                  label: `Every ${m} minutes`,
                }))}
                value={String(presetMinutes)}
                disabled={!canEdit}
                ariaLabel="Minute step"
                onChange={(v) => setPresetMinutes(Number(v))}
              />
            )}
            {presetKind === "every-n-hours" && (
              <Listbox
                options={SCHEDULE_EVERY_N_HOURS_STEPS.map((h) => ({
                  value: String(h),
                  label: `Every ${h} hour${h === 1 ? "" : "s"}`,
                }))}
                value={String(presetHours)}
                disabled={!canEdit}
                ariaLabel="Hour step"
                onChange={(v) => {
                  const hours = Number(v);
                  setPresetHours(hours);
                  reconcileTimezoneForPreset(presetKind, hours);
                }}
              />
            )}
            {(presetKind === "daily" || presetKind === "weekly") && (
              <div className="flex items-center gap-1.5">
                <NumberField
                  value={presetHour}
                  min={0}
                  max={23}
                  disabled={!canEdit}
                  onChange={(v) => setPresetHour(v ?? 0)}
                />
                <span className="font-mono text-[10px] text-neutral-600">:</span>
                <NumberField
                  value={presetMinute}
                  min={0}
                  max={59}
                  disabled={!canEdit}
                  onChange={(v) => setPresetMinute(v ?? 0)}
                />
              </div>
            )}
            {presetKind === "weekly" && (
              <ScheduleWeekdayToggles
                value={presetWeekdays}
                disabled={!canEdit}
                onChange={setPresetWeekdays}
              />
            )}
            {presetIgnoresTimezone && (
              <div className="font-body text-[11px] leading-[1.4] text-neutral-600">
                This preset fires at a fixed interval and does not observe daylight
                saving, so the timezone below does not apply to it. Applying it saves
                the schedule in {SCHEDULE_INTERVAL_PRESET_TIMEZONE} no matter what the
                timezone field says.
              </div>
            )}
            <button
              type="button"
              disabled={
                !canEdit ||
                preview.status !== "ok" ||
                preview.requestKey !== requestKey ||
                timezoneNeedsConfirmation
              }
              onClick={() => {
                if (preview.status === "ok") {
                  // Both fields, not just the cron: what is saved is what runs, and
                  // an interval preset's compiled timezone (UTC) can differ from
                  // whatever is currently typed in the timezone field below.
                  onChange("params.cron", preview.cron);
                  onChange("params.timezone", preview.timezone);
                  // Only a clock-anchored Apply updates the remembered zone: an
                  // interval preset's UTC is occurrence.ts's override, never the
                  // operator's own choice, and must not overwrite it (A1).
                  if (!presetIgnoresTimezone) setRememberedTimezone(preview.timezone);
                  setBuilderMode("custom");
                }
              }}
              className={webhookActionButtonCls}
            >
              Apply preset
            </button>
          </div>
        )}
      </ConfigField>
      <ConfigNote>
        Presets compile to a cron expression through the worker, the only place a
        schedule is ever evaluated, so a preset can never mean something the raw
        expression above would not. Switch to Custom to type an expression directly
        for anything a preset cannot express.
      </ConfigNote>
      <ConfigField label="Timezone">
        <TextInput
          value={timezoneNeedsConfirmation ? "" : timezone}
          disabled={!canEdit}
          placeholder="UTC"
          onChange={writeTimezone}
        />
      </ConfigField>
      {timezoneRestoredNotice !== null && (
        <ConfigNote>
          Restored your previous timezone ({timezoneRestoredNotice}): the preset you
          just left ignores it and saves {SCHEDULE_INTERVAL_PRESET_TIMEZONE} instead.
        </ConfigNote>
      )}
      {timezoneNeedsConfirmation && (
        <div role="alert" className="py-2.5 px-[14px] border-b border-neutral-200 font-body text-xs leading-[1.5] text-red-700">
          Your previous timezone could not be carried over. Choose one before applying
          this preset.
        </div>
      )}
      <ConfigNote>
        An IANA timezone name, for example Europe/Warsaw. Never left blank: without
        one the schedule would silently run in the host machine's timezone instead.
        {presetIgnoresTimezone &&
          " The preset selected above ignores this field, see the note next to it."}
      </ConfigNote>
      <ScheduleStatusPanel
        definitionId={definitionId}
        nodeId={node.id}
        canEdit={canEdit}
        draftCron={cron}
        draftTimezone={timezone}
        preview={preview}
        requestKey={requestKey}
      />
    </>
  );
}

function ScheduleTriggerFields({
  node,
  canEdit,
  definitionId,
  onChange,
}: {
  node: FlowNodeDef;
  canEdit: boolean;
  definitionId: number | undefined;
  onChange: ConfigChange;
}) {
  const overlapPolicy: ScheduleOverlapPolicy = SCHEDULE_OVERLAP_POLICY_OPTIONS.some(
    (option) => option.value === node.params.overlapPolicy,
  )
    ? (node.params.overlapPolicy as ScheduleOverlapPolicy)
    : "skip";

  // A suggestion only (item G): suggestedGraceMinutes comes from the same
  // debounced preview ScheduleCronBuilder already fetches for the cron
  // expression above, reported up rather than fetched a second time here.
  // It is never written to params.catchUpGraceMinutes on its own, only when
  // the operator clicks "Use suggestion", so an existing authored value is
  // never silently overwritten by a schedule edit.
  const [schedulePreview, setSchedulePreview] = useState<SchedulePreviewState>({
    status: "idle",
  });
  const suggestedGraceMinutes =
    schedulePreview.status === "ok" ? schedulePreview.suggestedGraceMinutes : null;
  const currentGraceMinutes =
    typeof node.params.catchUpGraceMinutes === "number" ? node.params.catchUpGraceMinutes : null;

  return (
    <>
      <ConfigField label="Task title">
        <TextInput
          value={str(node.params.taskTitle)}
          disabled={!canEdit}
          placeholder="Nightly dependency check"
          onChange={(v) => onChange("params.taskTitle", v)}
        />
      </ConfigField>
      <ConfigField label="Task description">
        <TextArea
          value={str(node.params.taskDescription)}
          disabled={!canEdit}
          placeholder="What should the agent do each time this fires?"
          onChange={(v) => onChange("params.taskDescription", v)}
        />
      </ConfigField>
      <ConfigNote>
        A scheduled run has no ticket, so the task title and description above are
        what it actually works on. Each occurrence opens its own pull request on its
        own branch: sharing one branch across occurrences would let a reviewer's push
        to it kill every later occurrence, so expect one pull request per occurrence,
        for example one a day on a daily schedule.
      </ConfigNote>
      <ScheduleCronBuilder
        node={node}
        canEdit={canEdit}
        definitionId={definitionId}
        onChange={onChange}
        onPreviewChange={setSchedulePreview}
      />
      <ConfigField label="If the previous run is still going">
        <Listbox
          options={SCHEDULE_OVERLAP_POLICY_OPTIONS}
          value={overlapPolicy}
          disabled={!canEdit}
          ariaLabel="Overlap policy"
          onChange={(v) => onChange("params.overlapPolicy", v)}
        />
      </ConfigField>
      {/* "two" is MAX_IN_FLIGHT_OCCURRENCES_PER_SCHEDULE in the worker's
          dispatch-schedule-trigger.ts, stated here as a word because the worker
          and the dashboard are different packages. It is the cap on THIS
          schedule, not the worker-wide agent pool: naming the pool here once
          described a limit allow does not have. Change one and change both. */}
      <ConfigNote>
        Skip: this occurrence does not run, and the reason is recorded. It will not
        run and will not be replayed. Queue: at most one occurrence waits, the newest
        one; an older waiting occurrence is settled as replaced, not run, and not
        replayed either. Allow: occurrences run alongside each other, up to two runs
        of this schedule at a time, so a run that outruns its own period does not cost
        you the next occurrence. A further occurrence is skipped as an overlap while
        those two are still going, which is what stops one schedule filling the
        worker with its own runs.
      </ConfigNote>
      <ConfigField label="Catch-up grace (minutes)">
        <div className="flex items-center gap-1.5">
          <NumberField
            value={node.params.catchUpGraceMinutes}
            min={5}
            max={1440}
            disabled={!canEdit}
            onChange={(v) => onChange("params.catchUpGraceMinutes", v)}
          />
          {canEdit &&
            suggestedGraceMinutes !== null &&
            suggestedGraceMinutes !== currentGraceMinutes && (
              <button
                type="button"
                onClick={() => onChange("params.catchUpGraceMinutes", suggestedGraceMinutes)}
                className={webhookActionButtonCls}
              >
                Use suggested {suggestedGraceMinutes}
              </button>
            )}
        </div>
      </ConfigField>
      <ConfigNote>
        How late a missed occurrence may still be and be worth running, for example
        after a deploy was broken for a while. Five minutes is the floor: the
        scheduler only checks once a minute, so a smaller tolerance means one slow
        tick alone can lose an occurrence.
        {suggestedGraceMinutes !== null &&
          suggestedGraceMinutes !== currentGraceMinutes &&
          ` Based on the schedule above, ${suggestedGraceMinutes} minutes would cover the typical gap between occurrences; this is only a suggestion, your own value above is kept until you choose to use it.`}
      </ConfigNote>
      <TriggerRateLimitFields
        node={node}
        canEdit={canEdit}
        definitionId={definitionId}
        schedule
        onChange={onChange}
      />
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

/**
 * Read-only view of the definition-level repository pin, editable through the
 * same modal the top bar opens. The pin is not trigger params, so this panel
 * shows it where the operator is looking without becoming a second editing path
 * that could normalize it differently.
 */
function PrRepositoriesField({
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

/** The tenant's currently configured script group names, unioned across every
 *  repository in Repository scripts, for the run_scripts block's Groups
 *  picker. Null while loading or on a failed fetch: the field still works as
 *  free text either way, so a failed fetch just means no suggestions and no
 *  unknown-group warnings, never a broken editor. */
function useConfiguredGroupNames(): string[] | null {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/pre-pr-checks", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<PrePrChecksResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        const repositories = data.current?.config.repositories ?? [];
        const union = new Set<string>();
        for (const repo of repositories) {
          const groupNames = Object.keys(repo.groups ?? {});
          if (groupNames.length > 0) {
            for (const name of groupNames) union.add(name);
          } else if ((repo.commands ?? []).length > 0) {
            // The engine normalizes a legacy flat-commands repository into
            // a single "checks" group at run time; the stored config never
            // spells that out, so without this an all-legacy tenant sees a
            // false "no repository declares \"checks\"" warning on a block
            // that actually runs fine.
            union.add("checks");
          }
        }
        setNames([...union].sort());
      })
      .catch(() => {
        if (!cancelled) setNames(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return names;
}

/** Shared Groups field for run_scripts and run_checks: the same free-text
 *  ArrayTextarea as before, plus configured group names offered as one-click
 *  adds and a non-blocking warning on any entered name no repository
 *  declares. Never blocks save: a block can legitimately name a group that
 *  will be added later, or one a different repository declares that hasn't
 *  loaded here yet. */
function RunScriptsGroupsField({
  node,
  disabled,
  onChange,
}: {
  node: FlowNodeDef;
  disabled: boolean;
  onChange: ConfigChange;
}) {
  const configuredGroups = useConfiguredGroupNames();
  const current = Array.isArray(node.params.groups) ? node.params.groups : [];
  const unknown =
    configuredGroups !== null ? current.filter((name) => !configuredGroups.includes(name)) : [];
  const suggestions = configuredGroups?.filter((name) => !current.includes(name)) ?? [];

  return (
    <ConfigField label="Groups">
      <ArrayTextarea
        key={`${node.id}:groups`}
        value={node.params.groups}
        disabled={disabled}
        mono
        placeholder="checks"
        onChange={(v) => onChange("params.groups", v)}
      />
      {!disabled && suggestions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-500">
            Configured:
          </span>
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onChange("params.groups", [...current, name])}
              className="rounded-xs border border-neutral-300 bg-white px-1.5 py-[2px] font-mono text-[10px] text-neutral-700 hover:bg-app-bg"
            >
              + {name}
            </button>
          ))}
        </div>
      ) : null}
      {unknown.map((name) => (
        <div
          key={name}
          className="rounded-xs border border-amber-300 bg-amber-50 px-2 py-1 font-body text-[11px] text-amber-800"
        >
          No repository declares &quot;{name}&quot;. The block will report it as not_run.
        </div>
      ))}
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
  onChange: ConfigChange;
}) {
  const promptAuthoring = usePromptAuthoringContext();
  const proseAuthoringMode = node.v2 ? "v2" : "v1";
  const proseValues = node.v2
    ? (promptAuthoring?.availableValues ?? [])
    : [];
  const valuesRefreshing = promptAuthoring?.valuesRefreshing ?? false;
  // "investigate" is registered in the worker's block registry but is not part
  // of the WorkflowBlockType union yet; the palette is data-driven, so the
  // type arrives here as a plain string once the worker ships the block.
  const nodeType: string = node.type;
  if (nodeType === "investigate") {
    return <InvestigateFields node={node} canEdit={canEdit} onChange={onChange} />;
  }
  const triggerDefinitionId = promptAuthoring?.previewCandidate?.definitionId;
  switch (node.type) {
    case "trigger_ticket_ai":
      return (
        <>
          <ConfigNote>Fires when a Jira ticket enters the AI column.</ConfigNote>
          <TriggerRateLimitFields
            node={node}
            canEdit={canEdit}
            definitionId={triggerDefinitionId}
            onChange={onChange}
          />
        </>
      );
    case "trigger_plan_approved":
      return <ConfigNote>Fires when a proposed plan is approved.</ConfigNote>;
    case "trigger_webhook":
      return (
        <WebhookTriggerFields
          key={node.id}
          node={node}
          canEdit={canEdit}
          definitionId={promptAuthoring?.previewCandidate?.definitionId}
          onChange={onChange}
        />
      );
    case "trigger_schedule":
      return (
        <ScheduleTriggerFields
          key={node.id}
          node={node}
          canEdit={canEdit}
          definitionId={promptAuthoring?.previewCandidate?.definitionId}
          onChange={onChange}
        />
      );
    case "trigger_pr_checks_failed":
      return (
        <>
          <PrProvidersField node={node} canEdit={canEdit} onChange={onChange} />
          <PrScopeField node={node} canEdit={canEdit} onChange={onChange} />
          <PrRepositoriesField node={node} canEdit={canEdit} />
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
          <ConfigField label="Ignored check names">
            <ArrayTextarea
              key={`${node.id}:ignoreCheckNames`}
              value={node.params.ignoreCheckNames}
              disabled={!canEdit}
              mono
              placeholder="lint"
              onChange={(value) => onChange("params.ignoreCheckNames", value ?? [])}
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
          <ConfigField label="Max fix attempts per PR">
            <NumberField
              value={node.params.maxFixAttemptsPerPr}
              min={1}
              max={10}
              disabled={!canEdit}
              onChange={(v) => onChange("params.maxFixAttemptsPerPr", v)}
            />
          </ConfigField>
          <ConfigNote>
            Leave the check names empty to react to every failing check, or list names to
            narrow it to those. GitHub defaults to the github-actions App; GitLab defaults to
            merge-request pipelines. Ignored check names never start a run even when they
            fail. Max fix attempts per PR caps how many automatic fix attempts one pull
            request may receive before the loop stops.
          </ConfigNote>
          <TriggerRateLimitFields
            node={node}
            canEdit={canEdit}
            definitionId={triggerDefinitionId}
            onChange={onChange}
          />
        </>
      );
    case "trigger_pr_created":
    case "trigger_pr_ready":
    case "trigger_pr_updated":
      return (
        <>
          <PrProvidersField node={node} canEdit={canEdit} onChange={onChange} />
          <PrScopeField node={node} canEdit={canEdit} onChange={onChange} />
          <PrRepositoriesField node={node} canEdit={canEdit} />
          <ConfigNote>
            {node.type === "trigger_pr_ready"
              ? "Fires when a non-draft PR opens, reopens, or becomes ready for review."
              : node.type === "trigger_pr_updated"
                ? "Fires only when the PR head commit changes."
                : "Only configured VCS integrations can receive these events."}
          </ConfigNote>
          <TriggerRateLimitFields
            node={node}
            canEdit={canEdit}
            definitionId={triggerDefinitionId}
            onChange={onChange}
          />
        </>
      );
    case "trigger_pr_merged":
      return (
        <>
          <PrProvidersField node={node} canEdit={canEdit} onChange={onChange} />
          <PrScopeField node={node} canEdit={canEdit} onChange={onChange} />
          <PrRepositoriesField node={node} canEdit={canEdit} />
          <ConfigNote>Fires after a pull or merge request is merged.</ConfigNote>
          <TriggerRateLimitFields
            node={node}
            canEdit={canEdit}
            definitionId={triggerDefinitionId}
            onChange={onChange}
          />
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
          <PrRepositoriesField node={node} canEdit={canEdit} />
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
          <ConfigField label="Max runs per PR">
            <NumberField
              value={node.params.maxRunsPerPr}
              min={1}
              max={30}
              disabled={!canEdit}
              onChange={(v) => onChange("params.maxRunsPerPr", v)}
            />
          </ConfigField>
          <ConfigNote>
            Max runs per PR caps how many runs this trigger may start for one pull request
            before further deliveries are dropped.
          </ConfigNote>
          <TriggerRateLimitFields
            node={node}
            canEdit={canEdit}
            definitionId={triggerDefinitionId}
            onChange={onChange}
          />
        </>
      );
    }
    case "planning_agent":
    case "implementation_agent":
    case "review_agent": {
      return (
        <>
          <AgentProviderModel node={node} options={options} canEdit={canEdit} onChange={onChange} />
          <PromptField
            label={node.v2 ? "Role / task prompt" : "Prompt"}
            paramKey="prompt"
            node={node}
            disabled={!canEdit}
            mono
            defaultPromptName={DEFAULT_PROMPT_NAME_BY_AGENT[node.type]}
            onChange={onChange}
          />
        </>
      );
    }
    case "fix_agent":
      return (
        <>
          <AgentProviderModel node={node} options={options} canEdit={canEdit} onChange={onChange} />
          <PromptField
            label={node.v2 ? "Role / task instructions" : "Instructions"}
            paramKey="instructions"
            node={node}
            disabled={!canEdit}
            onChange={onChange}
          />
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
          <PromptField
            label={node.v2 ? "Role / task prompt" : "Prompt"}
            paramKey="prompt"
            node={node}
            disabled={!canEdit}
            onChange={onChange}
          />
          <OutputSchemaField node={node} disabled={!canEdit} onChange={onChange} />
        </>
      );
    case "call_llm":
      return (
        <>
          <PromptField
            label="Prompt"
            paramKey="prompt"
            node={node}
            disabled={!canEdit}
            agentPromptAuthoring={false}
            onChange={onChange}
          />
          <PromptField
            label="System"
            paramKey="system"
            node={node}
            disabled={!canEdit}
            agentPromptAuthoring={false}
            onChange={onChange}
          />
          <ConfigField label="Model">
            <TextInput value={str(node.params.model)} disabled={!canEdit} onChange={(v) => onChange("params.model", v)} />
          </ConfigField>
          <OutputSchemaField node={node} disabled={!canEdit} onChange={onChange} />
        </>
      );
    case "prepare_workspace":
      return <ConfigNote>Creates or reuses a managed code workspace for modular blocks.</ConfigNote>;
    case "finalize_workspace":
      return (
        <ConfigNote>
          To gate publication on check results, route a Branch using steps.&lt;id&gt;.output.allPassed
          for strict gating: it requires the selected groups to actually run and pass.
          steps.&lt;id&gt;.output.ok also passes when nothing matched, so prefer allPassed when
          publication should depend on scripts having run.
        </ConfigNote>
      );
    case "run_pre_pr_checks": {
      const cycles = node.params.maxFixCycles;
      return (
        <>
          <ConfigNote>
            Commands are configured in{" "}
            <Link href="/scripts" className="text-mariner underline">Repository scripts</Link>.
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
    case "run_scripts":
      return (
        <>
          <RunScriptsGroupsField node={node} disabled={!canEdit} onChange={onChange} />
          <ConfigNote>
            Group names come from the repository&apos;s script groups, configured in{" "}
            <Link href="/scripts" className="text-mariner underline">Repository scripts</Link>.
            output.ok is true when nothing matched; output.allPassed additionally requires that a
            selected group actually ran and passed. The block runs the selected groups on every
            repository in the run workspace, whether or not that repository changed.
          </ConfigNote>
        </>
      );
    case "run_checks": {
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
          <RunScriptsGroupsField node={node} disabled={!canEdit} onChange={onChange} />
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
            configured in{" "}
            <Link href="/scripts" className="text-mariner underline">Repository scripts</Link>.
          </ConfigNote>
        </>
      );
    }
    case "fetch_pr_context":
      return <ConfigNote>Loads the pull request diff, files and metadata for downstream steps.</ConfigNote>;
    case "open_pr":
      return (
        <>
          <ConfigField label="Title">
            {node.v2 ? (
              <RichTextField
                value={str(node.params.title)}
                disabled={!canEdit}
                authoringMode="v2"
                availableValues={proseValues}
                minHeightClass="min-h-[42px]"
                compact
                singleLine
                onChange={(v) => onChange("params.title", v)}
              />
            ) : (
              <TextInput
                value={str(node.params.title)}
                disabled={!canEdit}
                placeholder={DEFAULT_OPEN_PR_TITLE}
                onChange={(v) => onChange("params.title", v)}
              />
            )}
          </ConfigField>
          <ConfigField label="Description">
            <RichTextField
              value={str(node.params.body)}
              disabled={!canEdit}
              authoringMode={proseAuthoringMode}
              availableValues={proseValues}
              onChange={(v) => onChange("params.body", v)}
            />
          </ConfigField>
          <ConfigNote>
            {node.v2
              ? "Use the Value picker to insert data guaranteed to be available at this step. Leave a field empty to use the default."
              : "Templates for the pull request opened on the ticket branch. Variables like {{ticket_key}}, {{ticket_title}}, {{ticket_url}} (issue tracker link) and {{change_summary}} (what the agent changed) are substituted at run time. Leave a field empty to use the default."}
          </ConfigNote>
        </>
      );
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
          <RichTextField
            value={str(node.params.body)}
            disabled={!canEdit}
            authoringMode={proseAuthoringMode}
            availableValues={proseValues}
            onChange={(v) => onChange("params.body", v)}
          />
        </ConfigField>
      );
    case "post_pr_comment":
      return (
        <>
          <ConfigField label="Body">
            <RichTextField
              value={str(node.params.body)}
              disabled={!canEdit}
              authoringMode={proseAuthoringMode}
              availableValues={proseValues}
              onChange={(v) => onChange("params.body", v)}
            />
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
    case "create_pr_check":
      return (
        <>
          <ConfigField label="Check name">
            <TextInput
              value={str(node.params.checkName)}
              disabled={!canEdit}
              onChange={(value) => onChange("params.checkName", value)}
            />
          </ConfigField>
          <ConfigNote>
            Creates a pending check for the exact pull request commit that started this run.
          </ConfigNote>
        </>
      );
    case "complete_pr_check":
      return (
        <>
          <ConfigField label="Conclusion">
            <Listbox
              options={[
                { value: "success", label: "Success" },
                { value: "failure", label: "Failure" },
                { value: "neutral", label: "Neutral" },
              ]}
              value={str(node.params.conclusion) || "success"}
              disabled={!canEdit}
              ariaLabel="PR check conclusion"
              onChange={(value) => onChange("params.conclusion", value)}
            />
          </ConfigField>
          <ConfigField label="Details">
            <RichTextField
              value={str(node.params.details)}
              disabled={!canEdit}
              authoringMode={proseAuthoringMode}
              availableValues={proseValues}
              onChange={(value) => onChange("params.details", value)}
            />
          </ConfigField>
          <ConfigNote>
            Only a check created by this run for the same PR head can be completed.
          </ConfigNote>
        </>
      );
    case "post_pr_review":
      return (
        <ConfigNote>
          Publishes the selected Review Results as one review. Findings that cannot be
          placed safely on the exact diff are included in the review summary.
        </ConfigNote>
      );
    case "send_slack_message": {
      const sendOn = str(node.params.sendOn) === "always" ? "always" : "pr_ready";
      return (
        <>
          <ConfigField label="When to send">
            <Listbox
              options={[
                { value: "pr_ready", label: "Only when a PR is ready" },
                { value: "always", label: "Always (standalone message)" },
              ]}
              value={sendOn}
              disabled={!canEdit}
              ariaLabel="When to send"
              onChange={(v) => onChange("params.sendOn", v)}
            />
          </ConfigField>
          <ConfigField label="Message">
            <RichTextField
              value={str(node.params.message)}
              disabled={!canEdit}
              authoringMode={proseAuthoringMode}
              availableValues={proseValues}
              onChange={(v) => onChange("params.message", v)}
            />
          </ConfigField>
          <ConfigNote>
            {sendOn === "always"
              ? node.v2
                ? "Posts your message as a standalone note in the ticket thread whenever this block runs. Use the Value picker to add a PR link when one is available."
                : "Posts your message as a standalone note in the ticket thread whenever this block runs. Add {{pr_url}} if you want a PR link."
              : "Appends your message under the PR ready card, only after a pull request is published."}
          </ConfigNote>
        </>
      );
    }
    case "human_question":
      return (
        <ConfigField label="Questions">
          {node.v2 ? (
            <CanonicalQuestionsField
              value={node.params.questions}
              disabled={!canEdit}
              availableValues={proseValues}
              valuesRefreshing={valuesRefreshing}
              onChange={(v) => onChange("params.questions", v)}
            />
          ) : (
            <ArrayTextarea
              key={`${node.id}:questions`}
              value={node.params.questions}
              disabled={!canEdit}
              placeholder="One question per line"
              onChange={(v) => onChange("params.questions", v)}
            />
          )}
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
    case "leak_review":
      return (
        <>
          <ConfigField label="Model">
            <TextInput
              value={str(node.params.model)}
              disabled={!canEdit}
              onChange={(v) => onChange("params.model", v)}
            />
          </ConfigField>
          <ConfigField label="LLM scan">
            <label className="flex items-center gap-2 font-body text-xs text-coal">
              <input
                type="checkbox"
                checked={node.params.llmScan !== false}
                disabled={!canEdit}
                onChange={(e) => onChange("params.llmScan", e.target.checked)}
                className="w-3.5 h-3.5 accent-mariner"
              />
              Add a report-only LLM screen for sensitive data
            </label>
          </ConfigField>
          <ConfigField label="Max diff bytes">
            <NumberField
              value={node.params.maxDiffBytes}
              min={1}
              max={262144}
              disabled={!canEdit}
              onChange={(v) => onChange("params.maxDiffBytes", v)}
            />
          </ConfigField>
          <ConfigNote>
            The secret scan always runs and fails the run before the branch is pushed. The
            LLM screen only reports findings.
          </ConfigNote>
        </>
      );
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
            <RichTextField
              value={str(node.params.postComment)}
              disabled={!canEdit}
              authoringMode={proseAuthoringMode}
              availableValues={proseValues}
              onChange={(v) => onChange("params.postComment", v)}
            />
          </ConfigField>
        </>
      );
  }
  return null;
}
