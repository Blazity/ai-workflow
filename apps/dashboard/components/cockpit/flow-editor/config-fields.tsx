"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import Link from "next/link";
import type { FlowNodeDef } from "@/lib/flows";
import type {
  PromptSourceRef,
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
  key: "mapSubject" | "mapDescription" | "mapRequester" | "mapPriority";
  label: string;
  placeholder: string;
}[] = [
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
  if (remaining <= 0) return "any moment now";
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
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
        URL and signing secret appear here.
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
  onReload,
}: {
  config: WebhookEndpointConfigResponse | null;
  loading: boolean;
  loadError: string | null;
  canEdit: boolean;
  busy: boolean;
  actionError: string | null;
  confirm: WebhookConfirmAction | null;
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
          no run can start from it. Unrevoke issues a new signing secret.
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
          setConfirm(action);
        }}
        onConfirmCancel={() => {
          setConfirm(null);
          setActionError(null);
        }}
        onConfirmRun={(action) => void run(action)}
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
  // Every one of these keys is optional and the registry supplies the default,
  // so an emptied field has to delete the key rather than store "".
  const write = (key: string) => (value: string) =>
    onChange(`params.${key}`, value.trim() === "" ? undefined : value);

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
      <WebhookEndpointPanel
        definitionId={definitionId}
        nodeId={node.id}
        triggerLabel={node.name ?? node.id}
        canEdit={canEdit}
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
  switch (node.type) {
    case "trigger_ticket_ai":
      return <ConfigNote>Fires when a Jira ticket enters the AI column.</ConfigNote>;
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
        </>
      );
    case "trigger_pr_merged":
      return (
        <>
          <PrProvidersField node={node} canEdit={canEdit} onChange={onChange} />
          <PrScopeField node={node} canEdit={canEdit} onChange={onChange} />
          <PrRepositoriesField node={node} canEdit={canEdit} />
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
