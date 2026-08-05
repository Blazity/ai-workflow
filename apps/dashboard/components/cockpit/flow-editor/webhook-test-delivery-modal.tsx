"use client";

import { useEffect, useRef, useState } from "react";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type {
  WebhookMappedEntry,
  WebhookTestDeliveryResponse,
} from "@shared/contracts";
import { readErrorMessage } from "@/lib/api/error-message";

const SAMPLE_PAYLOAD = `{
  "subject": "Card reader is offline",
  "description": "Terminal 4 stopped reading cards after the update.",
  "requester": "ops@example.com",
  "priority": "high"
}`;

/** The untouched body is deliberately absent: it is the operator's own input,
 *  and echoing it back into a 476px dialog buys nothing. */
const MAPPED_FIELDS: readonly {
  key: Exclude<keyof WebhookMappedEntry, "payload">;
  label: string;
}[] = [
  { key: "subject", label: "subject" },
  { key: "description", label: "description" },
  { key: "requester", label: "requester" },
  { key: "priority", label: "priority" },
];

/** Renders the probe result on its own so the outcome markup can be asserted
 *  without driving the form. */
export function WebhookTestDeliveryResultView({
  result,
}: {
  result: WebhookTestDeliveryResponse;
}) {
  return (
    <div
      role="status"
      className="mt-5 rounded-[3px] border border-neutral-300 bg-app-bg px-4 py-3"
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-600">
        Outcome
      </div>
      <div className="mt-0.5 font-body text-[13px] font-semibold text-coal">
        {result.outcome}
        {result.reason ? ` · ${result.reason}` : ""}
      </div>
      <div className="mt-3 font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-600">
        Delivery id
      </div>
      <div className="mt-0.5 break-all font-mono text-[12px] text-coal">
        {result.deliveryId}
      </div>
      <div className="mt-3 font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-600">
        Subject id
      </div>
      <div className="mt-0.5 break-all font-mono text-[12px] text-coal">
        {result.subjectId
          ? result.subjectId
          : "none, so this delivery would get its own subject"}
      </div>
      <dl className="mt-3 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1">
        {MAPPED_FIELDS.map((field) => (
          <div key={field.key} className="contents">
            <dt className="font-mono text-[11px] text-neutral-600">
              {field.label}
            </dt>
            <dd className="m-0 break-all font-body text-[12px] text-coal">
              {result.entry[field.key] === ""
                ? "(empty)"
                : result.entry[field.key]}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Dry-run probe for a webhook endpoint. It maps a body exactly like a real
 * delivery and reports what the trigger would have seen, but it never starts a
 * workflow, so an operator can iterate on dot-paths without producing runs.
 */
export function WebhookTestDeliveryModal({
  definitionId,
  nodeId,
  triggerLabel,
  onClose,
}: {
  definitionId: number;
  nodeId: string;
  triggerLabel: string;
  onClose: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [payload, setPayload] = useState(SAMPLE_PAYLOAD);
  const [result, setResult] = useState<WebhookTestDeliveryResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function send() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      setResult(null);
      setError("This body is not valid JSON, so there is nothing to map.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/workflow-definitions/${definitionId}/triggers/${encodeURIComponent(nodeId)}/webhook/test-delivery`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payload: parsed }),
          cache: "no-store",
        },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response));
      setResult((await response.json()) as WebhookTestDeliveryResponse);
    } catch (caught) {
      setResult(null);
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to send this test delivery",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-coal/30 px-4 py-6 backdrop-blur-[1px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="webhook-test-delivery-title"
        className="w-full max-w-[476px] overflow-hidden rounded-[6px] border border-neutral-200 bg-panel shadow-[0_18px_60px_rgba(24,27,32,0.22)]"
      >
        <div className="px-7 pb-6 pt-7">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <h2
                id="webhook-test-delivery-title"
                className="font-display text-[20px] font-semibold leading-tight text-coal"
              >
                Send test delivery
              </h2>
              <p className="mt-1 font-body text-[13px] text-neutral-600">
                {triggerLabel}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close test delivery"
              className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-neutral-600 hover:bg-app-bg hover:text-coal"
            >
              <XIcon size={19} weight="bold" aria-hidden />
            </button>
          </div>

          <div className="mt-4 border-l-2 border-mariner bg-app-bg px-3 py-2 font-body text-[12px] leading-relaxed text-neutral-700">
            This is a dry run. The body is mapped exactly like a real delivery
            and the result is logged as a test, but no workflow starts and no
            signature is checked.
          </div>

          <label
            htmlFor="webhook-test-delivery-payload"
            className="mt-6 block font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-600"
          >
            JSON body
          </label>
          <textarea
            ref={textareaRef}
            id="webhook-test-delivery-payload"
            value={payload}
            rows={9}
            spellCheck={false}
            onChange={(event) => {
              setPayload(event.target.value);
              setResult(null);
              setError(null);
            }}
            className="mt-2 w-full resize-y rounded-[3px] border border-neutral-300 bg-panel px-3 py-2 font-mono text-[12px] leading-[1.5] text-coal outline-none focus:border-mariner focus:ring-2 focus:ring-mariner/15"
          />

          {error && (
            <div
              role="alert"
              className="mt-5 rounded-[3px] border border-red-300 bg-red-50 px-3 py-2 font-body text-[12px] text-red-700"
            >
              {error}
            </div>
          )}

          {result && <WebhookTestDeliveryResultView result={result} />}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-neutral-200 bg-app-bg px-7 py-4">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer border-none bg-transparent px-2 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-neutral-700"
          >
            {result ? "Close" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy || payload.trim() === ""}
            className="cursor-pointer rounded-[3px] border border-mariner bg-mariner px-4 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-white shadow-[0_2px_4px_rgba(60,67,231,0.2)] hover:bg-[#3037d8] disabled:cursor-default disabled:opacity-40"
          >
            {busy ? "Sending…" : "Send test delivery"}
          </button>
        </div>
      </section>
    </div>
  );
}
