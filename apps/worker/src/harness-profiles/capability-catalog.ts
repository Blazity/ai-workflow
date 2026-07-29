import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { and, eq } from "drizzle-orm";
import type {
  HarnessCapabilitiesResponse,
  HarnessCapabilityCatalog,
  HarnessCapabilityOption,
  HarnessModelCapability,
  HarnessProfileDraftManifestV1,
  HarnessProfileDraftManifestV2,
  HarnessProvider,
} from "@shared/contracts";
import { buildHarnessProfileDraftV2 } from "@shared/contracts";
import type { Db } from "../db/client.js";
import {
  harnessCapabilityCatalogs,
  organization,
} from "../db/schema.js";
import { logger } from "../lib/logger.js";
import {
  HARNESS_PROVIDER_CONTRACTS,
  stableJson,
} from "./manifest.js";

export const HARNESS_CAPABILITY_CACHE_TTL_MS = 15 * 60 * 1_000;
export const HARNESS_CAPABILITY_PREWARM_LEAD_MS = 5 * 60 * 1_000;
export const CLAUDE_CAPABILITY_DISCOVERY_TIMEOUT_MS = 180_000;
export const CODEX_CAPABILITY_DISCOVERY_TIMEOUT_MS = 180_000;
export const HARNESS_CAPABILITY_REFRESH_THROTTLE_MS = 30_000;

const inFlightRefreshes = new Map<
  string,
  Promise<HarnessCapabilitiesResponse>
>();

export class HarnessCapabilityCatalogError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

class HarnessCapabilityDiscoveryPrerequisiteError extends Error {}

export interface HarnessCapabilityDiscoveryDependencies {
  now?: () => Date;
  discoverClaude?: (
    cliVersion: string,
    signal: AbortSignal,
  ) => Promise<HarnessCapabilityCatalog>;
  discoverCodex?: (
    cliVersion: string,
    signal: AbortSignal,
  ) => Promise<HarnessCapabilityCatalog>;
}

type CachedCatalog = typeof harnessCapabilityCatalogs.$inferSelect;

export async function getHarnessCapabilities(
  db: Db,
  input: {
    organizationId: string;
    provider: HarnessProvider;
    cliVersion: string;
    refresh: boolean;
    dependencies?: HarnessCapabilityDiscoveryDependencies;
  },
): Promise<HarnessCapabilitiesResponse> {
  const refreshKey = [
    input.organizationId,
    input.provider,
    input.cliVersion,
  ].join(":");
  if (input.refresh) {
    const existing = inFlightRefreshes.get(refreshKey);
    if (existing) return existing;
    const pending = getHarnessCapabilitiesInternal(db, input);
    inFlightRefreshes.set(refreshKey, pending);
    try {
      return await pending;
    } finally {
      if (inFlightRefreshes.get(refreshKey) === pending) {
        inFlightRefreshes.delete(refreshKey);
      }
    }
  }
  return getHarnessCapabilitiesInternal(db, input);
}

async function getHarnessCapabilitiesInternal(
  db: Db,
  input: {
    organizationId: string;
    provider: HarnessProvider;
    cliVersion: string;
    refresh: boolean;
    dependencies?: HarnessCapabilityDiscoveryDependencies;
  },
): Promise<HarnessCapabilitiesResponse> {
  assertSupportedCliVersion(input.provider, input.cliVersion);

  const now = input.dependencies?.now?.() ?? new Date();
  const cached = await readCachedCatalog(db, input);
  if (
    input.refresh &&
    cached &&
    now.getTime() - cached.fetchedAt.getTime() <
      HARNESS_CAPABILITY_REFRESH_THROTTLE_MS
  ) {
    return responseFromCache(
      cached,
      !isCachedCatalogFresh(cached, now),
    );
  }
  if (
    !input.refresh &&
    cached &&
    isCachedCatalogFresh(cached, now)
  ) {
    return responseFromCache(cached, false);
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    input.provider === "codex"
      ? CODEX_CAPABILITY_DISCOVERY_TIMEOUT_MS
      : CLAUDE_CAPABILITY_DISCOVERY_TIMEOUT_MS,
  );
  const discoveryStartedAt = Date.now();
  let catalog: HarnessCapabilityCatalog;
  try {
    const discover =
      input.provider === "claude"
        ? (input.dependencies?.discoverClaude ?? discoverClaudeCapabilities)
        : (input.dependencies?.discoverCodex ?? discoverCodexCapabilities);
    catalog = normalizeCatalog(
      await discover(input.cliVersion, controller.signal),
    );
    logger.info(
      {
        event: "harness_capability_discovery",
        organization_id: input.organizationId,
        provider: input.provider,
        cli_version: input.cliVersion,
        duration_ms: Date.now() - discoveryStartedAt,
        model_count: catalog.models.length,
      },
      "Harness capability discovery completed",
    );
  } catch (error) {
    const failureMessage = safeDiscoveryFailure(error);
    logger.warn(
      {
        event: "harness_capability_discovery",
        organization_id: input.organizationId,
        provider: input.provider,
        cli_version: input.cliVersion,
        duration_ms: Date.now() - discoveryStartedAt,
        failure: failureMessage,
      },
      "Harness capability discovery failed",
    );
    if (cached) {
      const [row] = await db
        .update(harnessCapabilityCatalogs)
        .set({
          lastRefreshFailedAt: now,
          lastRefreshError: failureMessage,
          updatedAt: now,
        })
        .where(eq(harnessCapabilityCatalogs.id, cached.id))
        .returning();
      return responseFromCache(row ?? cached, true);
    }
    throw new HarnessCapabilityCatalogError(
      503,
      "Harness capabilities are temporarily unavailable.",
    );
  } finally {
    clearTimeout(timer);
  }

  const catalogHash = hashHarnessCapabilityCatalog(catalog);
  const [row] = await db
    .insert(harnessCapabilityCatalogs)
    .values({
      organizationId: input.organizationId,
      provider: input.provider,
      cliVersion: input.cliVersion,
      catalog,
      catalogHash,
      fetchedAt: now,
      lastRefreshFailedAt: null,
      lastRefreshError: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        harnessCapabilityCatalogs.organizationId,
        harnessCapabilityCatalogs.provider,
        harnessCapabilityCatalogs.cliVersion,
      ],
      set: {
        catalog,
        catalogHash,
        fetchedAt: now,
        lastRefreshFailedAt: null,
        lastRefreshError: null,
        updatedAt: now,
      },
    })
    .returning();
  return responseFromCache(row!, false);
}

/**
 * Request-time reads never launch provider discovery. Discovery may install a
 * pinned CLI and is therefore owned by the scheduled prewarm path below.
 */
export async function getCachedHarnessCapabilities(
  db: Db,
  input: {
    organizationId: string;
    provider: HarnessProvider;
    cliVersion: string;
    now?: () => Date;
  },
): Promise<HarnessCapabilitiesResponse> {
  assertSupportedCliVersion(input.provider, input.cliVersion);
  const now = input.now?.() ?? new Date();
  const cached = await readCachedCatalog(db, input);
  if (!cached) {
    throw new HarnessCapabilityCatalogError(
      503,
      missingCatalogMessage(input.provider, input.cliVersion),
    );
  }
  return responseFromCache(
    cached,
    !isCachedCatalogFresh(cached, now),
  );
}

export async function requireFreshHarnessCapabilities(
  db: Db,
  input: {
    organizationId: string;
    provider: HarnessProvider;
    cliVersion: string;
    now?: () => Date;
  },
): Promise<HarnessCapabilitiesResponse> {
  const response = await getCachedHarnessCapabilities(db, {
    organizationId: input.organizationId,
    provider: input.provider,
    cliVersion: input.cliVersion,
    now: input.now,
  });
  if (response.stale) {
    throw new HarnessCapabilityCatalogError(
      409,
      "Refresh Harness capabilities before publishing this profile.",
    );
  }
  return response;
}

export async function prewarmHarnessCapabilityCatalogs(
  db: Db,
  input: {
    dependencies?: HarnessCapabilityDiscoveryDependencies;
  } = {},
): Promise<{
  organizations: number;
  attempted: number;
  ready: number;
  stale: number;
  failed: number;
}> {
  const organizations = await db
    .select({ id: organization.id })
    .from(organization);
  const result = {
    organizations: organizations.length,
    attempted: 0,
    ready: 0,
    stale: 0,
    failed: 0,
  };

  for (const { id: organizationId } of organizations) {
    for (const provider of ["claude", "codex"] as const) {
      for (const cliVersion of HARNESS_PROVIDER_CONTRACTS[provider]
        .cliVersions) {
        result.attempted++;
        try {
          const now = input.dependencies?.now?.() ?? new Date();
          const cached = await readCachedCatalog(db, {
            organizationId,
            provider,
            cliVersion,
          });
          const capabilities = await getHarnessCapabilities(db, {
            organizationId,
            provider,
            cliVersion,
            refresh:
              !cached ||
              !isCachedCatalogFresh(cached, now) ||
              now.getTime() - cached.fetchedAt.getTime() >=
                HARNESS_CAPABILITY_CACHE_TTL_MS -
                  HARNESS_CAPABILITY_PREWARM_LEAD_MS,
            dependencies: input.dependencies,
          });
          if (capabilities.stale) result.stale++;
          else result.ready++;
        } catch (error) {
          result.failed++;
          logger.warn(
            {
              event: "harness_capability_prewarm",
              organization_id: organizationId,
              provider,
              cli_version: cliVersion,
              failure:
                error instanceof HarnessCapabilityCatalogError
                  ? error.message
                  : safeDiscoveryFailure(error),
            },
            "Harness capability prewarm failed",
          );
        }
      }
    }
  }

  return result;
}

export function hashHarnessCapabilityCatalog(
  catalog: HarnessCapabilityCatalog,
): string {
  return createHash("sha256").update(stableJson(catalog)).digest("hex");
}

export function upgradeHarnessDraftToV2(
  draft: HarnessProfileDraftManifestV1,
  capabilities: HarnessCapabilitiesResponse,
): HarnessProfileDraftManifestV2 {
  const model = capabilities.models.find(
    (candidate) => candidate.id === draft.model.id,
  );
  if (!model) {
    throw new HarnessCapabilityCatalogError(
      409,
      `Model "${draft.model.id}" is no longer available. Select a current model before publishing.`,
    );
  }
  if (
    !(model.defaultReasoningEffort ?? model.reasoningEfforts[0]?.id)
  ) {
    throw new HarnessCapabilityCatalogError(
      409,
      `Model "${draft.model.id}" does not advertise a usable reasoning effort.`,
    );
  }
  if (!(model.defaultServiceTier ?? model.serviceTiers[0]?.id)) {
    throw new HarnessCapabilityCatalogError(
      409,
      `Model "${draft.model.id}" does not advertise a usable service tier.`,
    );
  }
  const upgraded = buildHarnessProfileDraftV2(draft, capabilities);
  if (!upgraded) {
    throw new HarnessCapabilityCatalogError(
      409,
      `Model "${draft.model.id}" is not compatible with the current capability catalog.`,
    );
  }
  return upgraded;
}

/**
 * Converts an immutable v1 selection into an inspectable v2 draft without
 * inventing current provider capabilities. The placeholder can never be
 * published unchanged because publication refreshes and compares the live
 * catalog hash and exact model snapshot.
 */
export function upgradeHarnessDraftToHistoricalV2(
  draft: HarnessProfileDraftManifestV1,
): HarnessProfileDraftManifestV2 {
  const capability: HarnessModelCapability = {
    id: draft.model.id,
    name: draft.model.id,
    description:
      "Historical provider-default selection. Choose a current model before publishing.",
    contextWindowTokens: null,
    reasoningEfforts: [
      {
        id: "none",
        name: "Provider default",
        description: null,
      },
    ],
    defaultReasoningEffort: "none",
    serviceTiers: [
      { id: "standard", name: "Standard", description: null },
    ],
    defaultServiceTier: "standard",
    verbosityOptions: [],
    defaultVerbosity: null,
    compactionModes: ["model_default"],
  };
  const historicalCatalog: HarnessCapabilityCatalog = {
    provider: draft.harness.provider,
    packageName: draft.harness.packageName,
    cliVersion: draft.harness.cliVersion,
    protocolVersion: draft.harness.protocolVersion,
    models: [capability],
  };
  return {
    ...structuredClone(draft),
    schemaVersion: 2,
    model: {
      id: draft.model.id,
      reasoning: {
        selection: "model_default",
        effectiveEffort: "none",
      },
      serviceTier: "standard",
      capability,
      catalogHash: hashHarnessCapabilityCatalog(historicalCatalog),
    },
    compaction: { mode: "model_default" },
  };
}

async function readCachedCatalog(
  db: Db,
  input: {
    organizationId: string;
    provider: HarnessProvider;
    cliVersion: string;
  },
): Promise<CachedCatalog | null> {
  const [row] = await db
    .select()
    .from(harnessCapabilityCatalogs)
    .where(
      and(
        eq(
          harnessCapabilityCatalogs.organizationId,
          input.organizationId,
        ),
        eq(harnessCapabilityCatalogs.provider, input.provider),
        eq(harnessCapabilityCatalogs.cliVersion, input.cliVersion),
      ),
    )
    .limit(1);
  return row ?? null;
}

function assertSupportedCliVersion(
  provider: HarnessProvider,
  cliVersion: string,
): void {
  const providerContract = HARNESS_PROVIDER_CONTRACTS[provider];
  if (
    !(providerContract.cliVersions as readonly string[]).includes(
      cliVersion,
    )
  ) {
    throw new HarnessCapabilityCatalogError(
      400,
      "CLI version is not in the code-owned Harness Profile catalog.",
    );
  }
}

function isCachedCatalogFresh(
  row: CachedCatalog,
  now: Date,
): boolean {
  const unresolvedFailure =
    row.lastRefreshFailedAt !== null &&
    row.lastRefreshFailedAt.getTime() >= row.fetchedAt.getTime();
  return (
    !unresolvedFailure &&
    now.getTime() - row.fetchedAt.getTime() <
      HARNESS_CAPABILITY_CACHE_TTL_MS
  );
}

function missingCatalogMessage(
  provider: HarnessProvider,
  cliVersion: string,
): string {
  if (provider === "claude") {
    return "Claude model discovery is not ready. Configure ANTHROPIC_API_KEY on the worker and wait for the scheduled capability refresh.";
  }
  return `Codex model discovery for @openai/codex@${cliVersion} is not ready. Configure CODEX_API_KEY or CODEX_CHATGPT_OAUTH_TOKEN on the worker and check the scheduled capability refresh.`;
}

function responseFromCache(
  row: CachedCatalog,
  stale: boolean,
): HarnessCapabilitiesResponse {
  return {
    ...structuredClone(row.catalog),
    catalogHash: row.catalogHash,
    fetchedAt: row.fetchedAt.toISOString(),
    stale,
    refreshFailure:
      row.lastRefreshFailedAt && row.lastRefreshError
        ? {
            occurredAt: row.lastRefreshFailedAt.toISOString(),
            message: row.lastRefreshError,
          }
        : null,
  };
}

function normalizeCatalog(
  catalog: HarnessCapabilityCatalog,
): HarnessCapabilityCatalog {
  if (catalog.models.length === 0) {
    throw new Error("Provider returned no models.");
  }
  const modelIds = new Set<string>();
  const models = catalog.models.map((model) => {
    if (!model.id.trim() || modelIds.has(model.id)) {
      throw new Error("Provider returned an invalid model catalog.");
    }
    modelIds.add(model.id);
    const reasoningEfforts = uniqueOptions(model.reasoningEfforts);
    const serviceTiers = uniqueOptions(model.serviceTiers);
    const verbosityOptions = uniqueOptions(model.verbosityOptions);
    assertDefaultInOptions(
      model.defaultReasoningEffort,
      reasoningEfforts,
      "reasoning effort",
    );
    assertDefaultInOptions(
      model.defaultServiceTier,
      serviceTiers,
      "service tier",
    );
    assertDefaultInOptions(
      model.defaultVerbosity,
      verbosityOptions,
      "verbosity",
    );
    return {
      ...structuredClone(model),
      reasoningEfforts,
      serviceTiers,
      verbosityOptions,
      compactionModes: [...new Set(model.compactionModes)],
    };
  });
  return {
    provider: catalog.provider,
    packageName: catalog.packageName,
    cliVersion: catalog.cliVersion,
    protocolVersion: catalog.protocolVersion,
    models,
  };
}

function assertDefaultInOptions(
  defaultId: string | null,
  options: HarnessCapabilityOption[],
  label: string,
): void {
  if (
    defaultId !== null &&
    !options.some((option) => option.id === defaultId)
  ) {
    throw new Error(`Provider returned an invalid default ${label}.`);
  }
}

function uniqueOptions(
  options: HarnessCapabilityOption[],
): HarnessCapabilityOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (!option.id.trim() || seen.has(option.id)) return false;
    seen.add(option.id);
    return true;
  });
}

export async function discoverClaudeCapabilities(
  cliVersion: string,
  signal: AbortSignal,
  credential?: string,
): Promise<HarnessCapabilityCatalog> {
  const resolvedCredential =
    credential ?? (await import("../../env.js")).env.ANTHROPIC_API_KEY;
  if (!resolvedCredential) {
    throw new HarnessCapabilityDiscoveryPrerequisiteError(
      "Configure ANTHROPIC_API_KEY for Claude model discovery.",
    );
  }
  const rawModels = await readClaudeCodeModels(
    cliVersion,
    resolvedCredential,
    signal,
  );

  return {
    provider: "claude",
    packageName: HARNESS_PROVIDER_CONTRACTS.claude.packageName,
    cliVersion,
    protocolVersion:
      HARNESS_PROVIDER_CONTRACTS.claude.protocolVersions[0],
    models: rawModels
      .map(normalizeClaudeModel)
      .filter((model): model is HarnessModelCapability => model !== null),
  };
}

export function normalizeClaudeModel(
  raw: unknown,
): HarnessModelCapability | null {
  const record = objectRecord(raw);
  const id = stringValue(record.value);
  if (!id) return null;
  const displayName = stringValue(record.displayName) ?? id;
  const advertisedEfforts = stringArray(record.supportedEffortLevels) ?? [];
  const supportedEfforts = advertisedEfforts.filter((candidate) =>
    ["low", "medium", "high", "xhigh", "max"].includes(candidate),
  );
  const supportsEffort = record.supportsEffort;
  if (supportedEfforts.length === 0 && supportsEffort !== false) return null;
  if (supportedEfforts.length === 0) supportedEfforts.push("none");
  const efforts = supportedEfforts.map(optionFromId);
  return {
    id,
    name: displayName,
    description: stringValue(record.description),
    contextWindowTokens: null,
    reasoningEfforts: efforts,
    defaultReasoningEffort: supportsEffort === false ? "none" : null,
    serviceTiers: [
      {
        id: "standard",
        name: "Standard",
        description: "Pinned Claude CLI default service tier.",
      },
    ],
    defaultServiceTier: "standard",
    verbosityOptions: [],
    defaultVerbosity: null,
    compactionModes: ["model_default", "disabled"],
  };
}

export function claudeDiscoveryCredentialEnv(
  credential: string,
): Record<string, string> {
  return credential.startsWith("sk-ant-oat")
    ? { CLAUDE_CODE_OAUTH_TOKEN: credential }
    : { ANTHROPIC_API_KEY: credential };
}

async function readClaudeCodeModels(
  cliVersion: string,
  credential: string,
  signal: AbortSignal,
): Promise<unknown[]> {
  const isolatedHome = await mkdtemp(
    join(tmpdir(), "aiw-claude-models-"),
  );
  await writeFile(
    join(isolatedHome, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true }),
    { mode: 0o600 },
  );
  const child = spawn(
    "npx",
    [
      "--yes",
      `@anthropic-ai/claude-code@${cliVersion}`,
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--no-session-persistence",
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: isolatedHome,
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
        DISABLE_AUTOUPDATER: "1",
        ...claudeDiscoveryCredentialEnv(credential),
        npm_config_cache: join(
          tmpdir(),
          "aiw-claude-capability-npm-cache",
        ),
        npm_config_prefer_offline: "true",
      },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const lines = createInterface({ input: child.stdout });
  const requestId = "capability-initialize";
  let settled = false;
  let failInitialization: (error: Error) => void = () => {};
  const initialization = new Promise<unknown[]>((resolve, reject) => {
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    failInitialization = fail;
    lines.on("line", (line) => {
      try {
        const message = objectRecord(JSON.parse(line));
        const response = objectRecord(message.response);
        if (
          message.type !== "control_response" ||
          response.request_id !== requestId
        ) {
          return;
        }
        if (response.subtype !== "success") {
          fail(new Error("Claude Code model discovery was rejected."));
          return;
        }
        const payload = objectRecord(response.response);
        if (!Array.isArray(payload.models)) {
          fail(
            new Error(
              "Claude Code returned an invalid model catalog.",
            ),
          );
          return;
        }
        settled = true;
        resolve(payload.models);
      } catch {
        // Non-JSON diagnostics and unrelated SDK messages are ignored.
      }
    });
    child.once("error", fail);
    child.once("exit", () => {
      fail(new Error("Claude Code exited before model discovery."));
    });
    child.stdin.once("error", () => {
      fail(new Error("Claude Code model discovery input closed."));
    });
    child.stdin.write(
      `${JSON.stringify({
        request_id: requestId,
        type: "control_request",
        request: { subtype: "initialize" },
      })}\n`,
      (error) => {
        if (error) {
          fail(new Error("Claude Code model discovery input failed."));
        }
      },
    );
  });
  const abort = () => {
    child.kill("SIGKILL");
    failInitialization(
      new DOMException(
        "Claude Code capability discovery timed out.",
        "AbortError",
      ),
    );
  };
  signal.addEventListener("abort", abort, { once: true });

  try {
    return await initialization;
  } finally {
    signal.removeEventListener("abort", abort);
    child.kill("SIGTERM");
    lines.close();
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

async function discoverCodexCapabilities(
  cliVersion: string,
  signal: AbortSignal,
): Promise<HarnessCapabilityCatalog> {
  const rawModels = await readCodexAppServerModels(cliVersion, signal);
  return {
    provider: "codex",
    packageName: HARNESS_PROVIDER_CONTRACTS.codex.packageName,
    cliVersion,
    protocolVersion:
      HARNESS_PROVIDER_CONTRACTS.codex.protocolVersions[0],
    models: rawModels
      .map(normalizeCodexModel)
      .filter((model): model is HarnessModelCapability => model !== null),
  };
}

async function readCodexAppServerModels(
  cliVersion: string,
  signal: AbortSignal,
): Promise<unknown[]> {
  const { env } = await import("../../env.js");
  if (!env.CODEX_API_KEY && !env.CODEX_CHATGPT_OAUTH_TOKEN) {
    throw new HarnessCapabilityDiscoveryPrerequisiteError(
      "Configure CODEX_API_KEY or CODEX_CHATGPT_OAUTH_TOKEN for Codex model discovery.",
    );
  }
  const isolatedHome = await mkdtemp(join(tmpdir(), "aiw-codex-models-"));
  const child = spawn(
    "npx",
    [
      "--yes",
      `@openai/codex@${cliVersion}`,
      "app-server",
      "--listen",
      "stdio://",
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: isolatedHome,
        CODEX_HOME: join(isolatedHome, ".codex"),
        ...(env.CODEX_API_KEY
          ? { OPENAI_API_KEY: env.CODEX_API_KEY }
          : {}),
        ...(env.CODEX_CHATGPT_OAUTH_TOKEN
          ? { CODEX_ACCESS_TOKEN: env.CODEX_CHATGPT_OAUTH_TOKEN }
          : {}),
        npm_config_cache: join(
          tmpdir(),
          "aiw-codex-capability-npm-cache",
        ),
        npm_config_prefer_offline: "true",
      },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const lines = createInterface({ input: child.stdout });
  const responses = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const failPending = (error: Error) => {
    for (const pending of responses.values()) pending.reject(error);
    responses.clear();
  };
  lines.on("line", (line) => {
    try {
      const value = JSON.parse(line) as { id?: unknown; result?: unknown };
      const id = String(value.id ?? "");
      const pending = responses.get(id);
      if (!pending) return;
      responses.delete(id);
      pending.resolve(value.result);
    } catch {
      // App-server notifications and non-JSON diagnostics are ignored.
    }
  });
  child.once("error", failPending);
  child.once("exit", () => {
    failPending(new Error("Codex app-server exited."));
  });
  child.stdin.once("error", () => {
    failPending(new Error("Codex app-server input closed."));
  });
  const abort = () => {
    child.kill("SIGKILL");
    failPending(
      new DOMException("Codex capability discovery timed out.", "AbortError"),
    );
  };
  signal.addEventListener("abort", abort, { once: true });

  let requestId = 0;
  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = String(++requestId);
    return new Promise((resolve, reject) => {
      if (
        child.exitCode !== null ||
        child.stdin.destroyed ||
        child.stdin.writableEnded
      ) {
        reject(new Error("Codex app-server is not running."));
        return;
      }
      responses.set(id, { resolve, reject });
      child.stdin.write(
        `${JSON.stringify({ id, method, params })}\n`,
        (error) => {
          if (!error) return;
          responses.delete(id);
          reject(new Error("Codex app-server input failed."));
          failPending(new Error("Codex app-server input failed."));
        },
      );
    });
  };

  try {
    await request("initialize", {
      clientInfo: { name: "ai-workflow", version: "1" },
      capabilities: {},
    });
    if (
      child.exitCode !== null ||
      child.stdin.destroyed ||
      child.stdin.writableEnded
    ) {
      throw new Error("Codex app-server is not running.");
    }
    child.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`,
      (error) => {
        if (error) {
          failPending(new Error("Codex app-server input failed."));
        }
      },
    );
    const models: unknown[] = [];
    const seenCursors = new Set<string>();
    let pages = 0;
    let cursor: string | null = null;
    do {
      pages++;
      if (pages > 50) {
        throw new Error("Codex app-server returned too many model pages.");
      }
      const result = objectRecord(
        await request("model/list", {
          includeHidden: false,
          limit: 100,
          cursor,
        }),
      );
      const page = Array.isArray(result.data)
        ? result.data
        : Array.isArray(result.models)
          ? result.models
          : [];
      models.push(...page);
      cursor =
        stringValue(result.nextCursor) ??
        stringValue(result.next_cursor) ??
        null;
      if (cursor !== null) {
        if (seenCursors.has(cursor)) {
          throw new Error(
            "Codex app-server returned a repeated page cursor.",
          );
        }
        seenCursors.add(cursor);
      }
    } while (cursor);
    return models;
  } finally {
    signal.removeEventListener("abort", abort);
    child.kill("SIGTERM");
    lines.close();
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

function normalizeCodexModel(raw: unknown): HarnessModelCapability | null {
  const record = objectRecord(raw);
  const id =
    stringValue(record.id) ??
    stringValue(record.model) ??
    stringValue(record.slug);
  if (!id) return null;
  const rawEfforts = Array.isArray(record.supportedReasoningEfforts)
    ? record.supportedReasoningEfforts
    : Array.isArray(record.supported_reasoning_efforts)
      ? record.supported_reasoning_efforts
      : [];
  const reasoningEfforts = rawEfforts
    .map((entry) => {
      const option = objectRecord(entry);
      const effort =
        stringValue(option.reasoningEffort) ??
        stringValue(option.reasoning_effort) ??
        stringValue(option.id);
      return effort
        ? {
            id: effort,
            name: titleCase(effort),
            description: stringValue(option.description),
          }
        : null;
    })
    .filter((option): option is HarnessCapabilityOption => option !== null);
  if (reasoningEfforts.length === 0) {
    reasoningEfforts.push(optionFromId("none"));
  }
  const defaultReasoning =
    stringValue(record.defaultReasoningEffort) ??
    stringValue(record.default_reasoning_effort) ??
    reasoningEfforts[0]?.id ??
    null;

  const tierIds = new Set<string>(["standard"]);
  for (const value of [
    ...(stringArray(record.serviceTiers) ?? []),
    ...(stringArray(record.service_tiers) ?? []),
  ]) {
    tierIds.add(value);
  }
  for (const entry of Array.isArray(record.additionalSpeedTiers)
    ? record.additionalSpeedTiers
    : []) {
    const option = objectRecord(entry);
    const id =
      stringValue(option.serviceTier) ??
      stringValue(option.id) ??
      stringValue(option.slug);
    if (id) tierIds.add(id);
  }
  const contextWindow =
    positiveInteger(record.contextWindow) ??
    positiveInteger(record.context_window) ??
    positiveInteger(record.contextWindowTokens);
  const supportsVerbosity =
    record.supportsVerbosity === true ||
    record.supports_verbosity === true ||
    Array.isArray(record.supportedVerbosity);
  const verbosityIds = supportsVerbosity
    ? (stringArray(record.supportedVerbosity) ?? ["low", "medium", "high"])
    : [];
  return {
    id,
    name:
      stringValue(record.displayName) ??
      stringValue(record.display_name) ??
      id,
    description: stringValue(record.description),
    contextWindowTokens: contextWindow,
    reasoningEfforts,
    defaultReasoningEffort: defaultReasoning,
    serviceTiers: [...tierIds].map(optionFromId),
    defaultServiceTier:
      stringValue(record.defaultServiceTier) ??
      stringValue(record.default_service_tier) ??
      "standard",
    verbosityOptions: verbosityIds.map(optionFromId),
    defaultVerbosity:
      stringValue(record.defaultVerbosity) ??
      stringValue(record.default_verbosity) ??
      (verbosityIds.includes("medium") ? "medium" : (verbosityIds[0] ?? null)),
    compactionModes: [
      "model_default",
      ...(contextWindow === null ? [] : ["custom_threshold" as const]),
    ],
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map(stringValue)
    .filter((entry): entry is string => entry !== null);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : null;
}

function optionFromId(id: string): HarnessCapabilityOption {
  return { id, name: titleCase(id), description: null };
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function safeDiscoveryFailure(error: unknown): string {
  if (error instanceof HarnessCapabilityDiscoveryPrerequisiteError) {
    return error.message;
  }
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return "Capability discovery timed out.";
  }
  return "Capability discovery failed.";
}
