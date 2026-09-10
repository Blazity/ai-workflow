"use client";

import { useState } from "react";
import type { WebhookAuthScheme, WebhookDeliveryLogEntry, WebhookDeliveryOutcome, WebhookEndpointConfigResponse, WebhookEndpointRevivalResponse, WebhookRejectionSummaryEntry, WebhookRevealResponse, WebhookRevokeResponse, WebhookRotateResponse } from "@shared/contracts";
import { DEFAULT_WEBHOOK_SIGNATURE_HEADER, DEFAULT_WEBHOOK_TOKEN_HEADER } from "@shared/contracts";
import { ConfigField, ConfigNote, inputCls, readOnlyMonoCls, readOnlyRowCls, webhookActionButtonCls, webhookBannerCls, webhookDangerButtonCls } from "./shared";

export function defaultWebhookHeader(scheme: WebhookAuthScheme): string {
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

export type WebhookConfirmAction =
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

export const WEBHOOK_MAPPING_FIELDS: readonly {
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
