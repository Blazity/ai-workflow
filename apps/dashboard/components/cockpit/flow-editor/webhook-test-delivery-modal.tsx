"use client";

import { useRef, useState } from "react";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type {
  JsonValue,
  WebhookMappedEntry,
  WebhookTestDeliveryResponse,
} from "@shared/contracts";
import { apiClient } from "@/lib/api/client";
import { Button, IconButton, Modal, Textarea } from "@/components/ui";

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

  async function send() {
    let parsed: JsonValue;
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
      const response = await apiClient.triggers.webhookTestDelivery(
        definitionId,
        nodeId,
        { payload: parsed },
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(response.errorMessage);
      setResult(response.data);
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
    <Modal
      onClose={onClose}
      title="Send test delivery"
      description={triggerLabel}
      size="sm"
      initialFocusRef={textareaRef}
      footer={
        <div className="flex items-center justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>
            {result ? "Close" : "Cancel"}
          </Button>
          <Button
            onClick={() => void send()}
            disabled={busy || payload.trim() === ""}
          >
            {busy ? "Sending…" : "Send test delivery"}
          </Button>
        </div>
      }
    >
      <IconButton
        aria-label="Close test delivery"
        onClick={onClose}
        shape="circle"
        className="absolute right-4 top-3"
      >
        <XIcon size={19} weight="bold" aria-hidden />
      </IconButton>
      <div>
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
          <Textarea
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
            monospace
            className="mt-2"
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
    </Modal>
  );
}
