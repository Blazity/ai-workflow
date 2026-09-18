/**
 * What the integrations of this build contribute to a health scan.
 *
 * Core lists no provider here: it is handed one entry per integration the
 * registry ships, each carrying the manifest (what the checks are called), the
 * state the resolver decided (whether it is connected at all) and a way to run
 * that integration's own probes. Everything below is decided from those three.
 *
 * Pure: no registry, no database, no clock. The wiring that reads them is in
 * probes.ts, which is also the only place that holds a connection value.
 */
import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationHealthResult } from "@integrations/sdk";
import type {
  IntegrationFailureReason,
  IntegrationState,
  SystemHealthMode,
} from "@shared/contracts";

import { PublicHealthProbeError } from "./collect.js";
import { redactIntegrationText } from "../integrations/index.js";

import type {
  CheckBase,
  SystemHealthDefinition,
  SystemHealthProbeResult,
  SystemHealthProbes,
} from "./collect.js";

export interface IntegrationHealthEntry {
  readonly manifest: IntegrationManifest;
  /** From `resolveIntegrationState`; never derived a second time here. */
  readonly state: IntegrationState;
  /** One declared probe of this integration. Called only when it is usable. */
  readonly probe?: IntegrationHealthProbe;
  /** The secret values of the active connection, taken out of any text a probe
   *  produces. A provider that echoes a token in an error body is normal. */
  readonly secrets?: readonly string[];
}

type IntegrationHealthProbe = (
  checkId: string,
  signal: AbortSignal,
) => Promise<IntegrationHealthResult>;

export interface IntegrationHealthContributions {
  readonly definitions: SystemHealthDefinition[];
  readonly probes: SystemHealthProbes;
}

/** The id of the check core adds to every integration, before its own. */
const CONNECTION_CHECK_ID = "connection";

/**
 * What separates a contributed probe key from a core one.
 *
 * Probes are looked up by `${namespace}${section id}.${check id}` in one map,
 * and an integration's id is its own to choose: without this, an integration
 * called `github` declaring a check called `repositories` would replace core's
 * `github.repositories` probe, and the screen would show two GitHub rows that
 * could disagree. Conformance refuses the colliding id as well; this is the
 * half that holds for an integration conformance never saw.
 */
const INTEGRATION_PROBE_NAMESPACE = "integration:";

export function integrationHealthContributions(
  entries: readonly IntegrationHealthEntry[],
): IntegrationHealthContributions {
  const definitions: SystemHealthDefinition[] = [];
  const probes: SystemHealthProbes = {};

  for (const entry of entries) {
    const { manifest, state, probe } = entry;
    definitions.push({
      id: manifest.id,
      label: manifest.name,
      group: "integrations",
      // An integration is never critical to the platform: it is connected per
      // deployment and a workflow that does not use it is unaffected, so a
      // provider outage must not read as "the product is down".
      critical: false,
      description: manifest.description,
      probeNamespace: INTEGRATION_PROBE_NAMESPACE,
      checks: [connectionCheck(entry), ...declaredChecks(entry)],
    });
    // Only a usable integration is called. Nothing is probed on a deployment
    // that connected nothing, which is what keeps a first scan free of provider
    // requests, and a disabled integration stays untouched by design.
    if (!state.usable || !probe) continue;
    for (const check of manifest.health) {
      probes[`${INTEGRATION_PROBE_NAMESPACE}${manifest.id}.${check.id}`] = (signal) =>
        runIntegrationProbe(entry, probe, check.id, signal);
    }
  }

  return { definitions, probes };
}

/**
 * Runs one of an integration's probes and says what the scan should record.
 *
 * The collector's own timeout, latency and abort apply on top of this, so the
 * only thing decided here is how a provider's answer reads.
 */
async function runIntegrationProbe(
  entry: IntegrationHealthEntry,
  probe: IntegrationHealthProbe,
  checkId: string,
  signal: AbortSignal,
): Promise<SystemHealthProbeResult> {
  const safe = (text: string) => truncate(redactIntegrationText(text, redactable(entry)));
  try {
    const result: unknown = await probe(checkId, signal);
    const status = isRecord(result) ? result.status : undefined;
    // An integration is ordinary JavaScript written outside this repository. A
    // probe that returns nothing, or a word this report has no meaning for, has
    // measured nothing, and painting that Live is the one mistake a health
    // screen must never make.
    if (typeof status !== "string" || !PROBE_STATUSES.has(status)) {
      return {
        mode: "down",
        message:
          "The probe returned no usable result, so nothing about this check was verified.",
      };
    }
    const message = isRecord(result) && typeof result.message === "string" ? result.message : "";
    return {
      mode: status as IntegrationHealthResult["status"],
      ...(message ? { message: safe(message) } : {}),
    };
  } catch (error) {
    // A probe that throws is one failing check, never a failed scan, and it
    // carries the provider's own reason: "Health check failed." sends nobody
    // anywhere. The reason is redacted and bounded first, because a provider
    // that echoes a token in an error body is normal and this text is read on
    // a screen.
    throw new PublicHealthProbeError(safe(reasonOf(error)));
  }
}

/**
 * What an error says, including what it hides in its cause: `fetch` throws a
 * flat "fetch failed" and keeps "connect ECONNREFUSED" underneath, and the
 * second half is the one somebody can act on.
 */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  const detail = cause instanceof Error ? cause.message : undefined;
  return detail && !error.message.includes(detail)
    ? `${error.message}: ${detail}`
    : error.message;
}

/** The only answers a probe may give. Anything else is not a measurement. */
const PROBE_STATUSES = new Set(["live", "degraded", "down"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Every written form of this connection's secrets.
 *
 * The shared redactor covers a value as written, percent-encoded and base64.
 * A PEM key is echoed back JSON-escaped (`\n` for each newline), and a provider
 * quoting one line of it back would otherwise leak that line, so each form and
 * each substantial line goes in as a secret of its own.
 */
function redactable(entry: IntegrationHealthEntry): string[] {
  const forms = new Set<string>();
  for (const secret of entry.secrets ?? []) {
    if (secret.length === 0) continue;
    forms.add(secret);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) forms.add(escaped);
    for (const line of secret.split(/\r?\n/)) {
      // Short lines are coincidences, not credentials: a PEM header is public
      // and redacting it would mangle the sentence an admin has to read.
      if (line.trim().length >= MIN_SECRET_LINE) forms.add(line.trim());
    }
  }
  return [...forms];
}

/** Below this a line of a multiline secret is boilerplate, not a credential. */
const MIN_SECRET_LINE = 16;

/** Long enough for a provider's sentence, short enough for a row. */
const MAX_PROBE_MESSAGE = 300;

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "The check failed without a reason.";
  return collapsed.length <= MAX_PROBE_MESSAGE
    ? collapsed
    : `${collapsed.slice(0, MAX_PROBE_MESSAGE - 1)}…`;
}

/**
 * What the resolver knows, as a check: the one row that says whether anything
 * is connected at all, and what to do when it is not.
 */
function connectionCheck(entry: IntegrationHealthEntry): CheckBase {
  const { manifest, state } = entry;
  const base = {
    id: CONNECTION_CHECK_ID,
    label: "Connection",
    description: "Where this integration's values come from, and whether they are complete.",
    critical: true,
    evidenceSource: "configuration",
  } as const;

  if (!state.enabled) {
    return {
      ...base,
      mode: "disabled",
      envVars: [],
      message: `${manifest.name} is turned off on the Integrations page. Nothing it provides runs until it is enabled again.`,
    };
  }
  if (state.connection === "not_connected") {
    return {
      ...base,
      mode: "not-configured",
      envVars: [],
      message: `${manifest.name} is not connected. Connect it on the Integrations page.`,
    };
  }
  if (state.failure) {
    return {
      ...base,
      // A provider that answered and refused is an outage to act on now; a
      // value that is missing or unreadable is configuration to finish. The
      // two need different people, so they read differently.
      mode: providerRefused(state.failure.reason) ? "down" : "misconfigured",
      // The variables to set, and only those. Naming the ones that are already
      // set would send an admin to check what is not broken, and would tell
      // the setup overview that a variable it can see is missing.
      envVars: [...(state.failure.missingVariables ?? [])],
      message: state.failure.message,
    };
  }
  return {
    ...base,
    mode: "configured",
    envVars: connectionEnvVars(entry),
    message: connectedMessage(entry),
  };
}

/** Whether the provider itself refused, rather than the deployment being unfinished. */
function providerRefused(reason: IntegrationFailureReason): boolean {
  return reason === "credential_rejected" || reason === "provider_unreachable";
}

/**
 * The variables this connection actually reads. Stored values come from the
 * database, so naming variables for them would send an admin to set something
 * that changes nothing.
 */
function connectionEnvVars(entry: IntegrationHealthEntry): string[] {
  if (entry.state.source !== "environment") return [];
  return entry.manifest.connection.fields.map((field) => field.env);
}

/** What a connected integration says about the last connection test. */
function connectedMessage(entry: IntegrationHealthEntry): string {
  const source =
    entry.state.source === "environment"
      ? "Connected from this deployment's environment."
      : "Connected from values stored in the dashboard.";
  const verification = entry.state.verification;
  if (verification.state === "passed") return `${source} The last connection test passed.`;
  if (verification.state === "failed") return `${source} The last connection test failed.`;
  if (verification.state === "stale") {
    return `${source} The last connection test ran before these values changed.`;
  }
  return `${source} No connection test has been run.`;
}

/**
 * The checks the manifest declares, in its own order.
 *
 * `configured` is what the collector probes: a usable integration's checks are
 * settled by its own probes. Anything else has no connection to run against,
 * so the check reports the same mode as the connection above it rather than
 * inventing a result nobody measured.
 */
function declaredChecks(entry: IntegrationHealthEntry): CheckBase[] {
  const mode: SystemHealthMode = entry.state.usable
    ? "configured"
    : entry.state.enabled
      ? "not-configured"
      : "disabled";
  // "Not configured" is the badge this report has for an unprobed check, and it
  // is not what happened: the check was not run, because there was nothing to
  // run it against. The row says which.
  const message = entry.state.usable ? undefined : `Not checked: ${notCheckedReason(entry)}`;
  return entry.manifest.health.map((check) => ({
    id: check.id,
    label: check.label,
    description: check.description,
    critical: check.critical,
    mode,
    envVars: [],
    evidenceSource: "live-probe",
    ...(message ? { message } : {}),
  }));
}

function notCheckedReason(entry: IntegrationHealthEntry): string {
  if (!entry.state.enabled) return `${entry.manifest.name} is turned off.`;
  if (entry.state.connection === "not_connected") {
    return `${entry.manifest.name} is not connected.`;
  }
  return "the connection is not usable, so the provider was not called.";
}
