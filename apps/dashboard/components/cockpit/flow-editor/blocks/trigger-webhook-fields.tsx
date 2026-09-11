"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FlowNodeDef } from "@/lib/flows";
import type { WebhookAuthScheme, WebhookDeliveryLogEntry, WebhookEndpointConfigResponse } from "@shared/contracts";
import { DEFAULT_WEBHOOK_SIGNATURE_HEADER, DEFAULT_WEBHOOK_TIMESTAMP_HEADER, DEFAULT_WEBHOOK_TOKEN_HEADER } from "@shared/contracts";
import { apiClient } from "@/lib/api/client";
import { Listbox } from "@/components/cockpit/listbox";
import { WebhookTestDeliveryModal } from "../webhook-test-delivery-modal";
import { CheckboxRow, ConfigField, ConfigNote, TextInput, TriggerRateLimitFields, str } from "./shared";
import { WEBHOOK_MAPPING_FIELDS, WebhookDeliveriesSection, WebhookEndpointSection, defaultWebhookHeader } from "./webhook-endpoint";
import type { ConfigChange } from "./types";
import type { WebhookConfirmAction } from "./webhook-endpoint";

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

  const loadConfig = useCallback(async () => {
    if (definitionId === undefined) return;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await apiClient.triggers.webhookConfig(
        definitionId,
        nodeId,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(response.errorMessage);
      setConfig(response.data);
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
  }, [definitionId, nodeId]);

  const loadDeliveries = useCallback(async () => {
    if (definitionId === undefined) return;
    setDeliveriesLoading(true);
    setDeliveriesError(null);
    try {
      const response = await apiClient.triggers.webhookDeliveries(
        definitionId,
        nodeId,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(response.errorMessage);
      const payload = response.data;
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
  }, [definitionId, nodeId]);

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
    if (definitionId === undefined) return;
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
      const response = await apiClient.triggers.webhookAction(
        definitionId,
        nodeId,
        path,
        action === "force_rotate" ? { force: true } : {},
        { cache: "no-store" },
      );
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
      if (!response.ok) throw new Error(response.errorMessage);
      const payload = response.data;
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
    if (definitionId === undefined) return;
    setBusy(true);
    setActionError(null);
    try {
      const response = await apiClient.triggers.webhookSetSecret(
        definitionId,
        nodeId,
        { secret: value },
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(response.errorMessage);
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

export function WebhookTriggerFields({
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
      // Passing undefined deletes the optional tolerance parameter.
      // eslint-disable-next-line unicorn/no-useless-undefined -- Clear timestamp tolerance.
      onChange("params.timestampToleranceSeconds", undefined);
      return;
    }
    // Keep parseInt's prefix parsing for user-entered tolerance values.
    // eslint-disable-next-line unicorn/prefer-number-coercion -- Preserve prefix parsing.
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
