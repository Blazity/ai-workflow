import { createHash } from "node:crypto";
import type { PrePrCheckConfig } from "../pre-pr-checks/config.js";
import {
  parseVerifiedWorkspaceManifest,
  WORKSPACE_MANIFEST_PATH,
  type WorkspaceManifest,
} from "../sandbox/repo-workspace.js";

export interface WorkspaceGate {
  configurationVersion: number;
  fingerprint: string;
}

/** Minimal state shape shared-workspace mutators use to revoke an earlier gate. */
export interface WorkspaceGateState {
  prePrGate: WorkspaceGate | null;
}

export type WorkspaceGateRequirement =
  | {
      required: false;
      reason: "missing_configuration" | "no_applicable_checks";
      configurationVersion: number | null;
    }
  | {
      required: true;
      configurationVersion: number;
      fingerprint: string;
    };

interface InspectedWorkspaceRepository {
  provider: "github" | "gitlab";
  repoPath: string;
  preAgentSha?: string;
  headSha: string;
}

interface InspectedWorkspace {
  fingerprint: string;
  repositories: InspectedWorkspaceRepository[];
}

export class WorkspaceGateError extends Error {
  constructor(
    readonly code:
      | "missing_gate"
      | "configuration_changed"
      | "workspace_changed"
      | "workspace_unverifiable",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceGateError";
  }
}

export function invalidateWorkspaceGate(state: WorkspaceGateState): void {
  state.prePrGate = null;
}

/**
 * Canonical fingerprint input includes the complete trusted manifest and one
 * HEAD per repository in manifest order. Clean-worktree verification happens
 * before this pure helper is called.
 */
export function fingerprintWorkspaceState(
  workspaceManifest: WorkspaceManifest,
  headShas: readonly string[],
): string {
  if (headShas.length !== workspaceManifest.repositories.length) {
    throw new Error("Workspace fingerprint requires one HEAD for every repository");
  }
  const payload = {
    version: 1,
    workspaceManifest,
    repositories: workspaceManifest.repositories.map((repo, index) => ({
      provider: repo.provider,
      repoPath: repo.repoPath,
      headSha: headShas[index],
    })),
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** Capture the exact clean workspace state after an applicable check suite passes. */
export async function recordSuccessfulWorkspaceGate(input: {
  sandboxId: string;
  workspaceManifest: WorkspaceManifest;
  configurationVersion: number;
}): Promise<WorkspaceGate> {
  if (!Number.isSafeInteger(input.configurationVersion) || input.configurationVersion < 1) {
    throw new Error("Workspace gate requires a valid configuration version");
  }
  const inspected = await inspectWorkspaceForGateStep(
    input.sandboxId,
    input.workspaceManifest,
  );
  return {
    configurationVersion: input.configurationVersion,
    fingerprint: inspected.fingerprint,
  };
}

/**
 * Publication boundary. It independently reloads the current check config,
 * determines whether it applies to this Run Workspace, and verifies both the
 * immutable config version and the exact clean repository state.
 */
export async function assertCurrentWorkspaceGate(input: {
  sandboxId: string;
  workspaceManifest: WorkspaceManifest;
  gate: WorkspaceGate | null;
}): Promise<WorkspaceGateRequirement> {
  const current = await loadCurrentPrePrCheckConfigStep();
  if (!current || current.config.repositories.length === 0) {
    return {
      required: false,
      reason: "missing_configuration",
      configurationVersion: current?.version ?? null,
    };
  }

  let inspected: InspectedWorkspace;
  try {
    inspected = await inspectWorkspaceForGateStep(
      input.sandboxId,
      input.workspaceManifest,
    );
  } catch {
    throw new WorkspaceGateError(
      "workspace_unverifiable",
      "The Run Workspace could not be verified at the publication boundary.",
    );
  }

  if (!hasApplicableChecks(current.config, inspected.repositories)) {
    return {
      required: false,
      reason: "no_applicable_checks",
      configurationVersion: current.version,
    };
  }
  if (!input.gate) {
    throw new WorkspaceGateError(
      "missing_gate",
      "Applicable pre-publication checks have not passed for this Run Workspace.",
    );
  }
  if (input.gate.configurationVersion !== current.version) {
    throw new WorkspaceGateError(
      "configuration_changed",
      "The pre-publication check configuration changed after checks passed.",
    );
  }
  if (input.gate.fingerprint !== inspected.fingerprint) {
    throw new WorkspaceGateError(
      "workspace_changed",
      "The Run Workspace changed after pre-publication checks passed.",
    );
  }
  return {
    required: true,
    configurationVersion: current.version,
    fingerprint: inspected.fingerprint,
  };
}

async function loadCurrentPrePrCheckConfigStep(): Promise<{
  version: number;
  config: PrePrCheckConfig;
} | null> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { getCurrentPrePrCheckConfig } = await import("../pre-pr-checks/store.js");
  const current = await getCurrentPrePrCheckConfig(getDb());
  return current ? { version: current.version, config: current.config } : null;
}
loadCurrentPrePrCheckConfigStep.maxRetries = 0;

async function inspectWorkspaceForGateStep(
  sandboxId: string,
  trustedManifest: WorkspaceManifest,
): Promise<InspectedWorkspace> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  const manifestResult = await sandbox.runCommand("cat", [WORKSPACE_MANIFEST_PATH]);
  if (manifestResult.exitCode !== 0) {
    throw new Error("Run Workspace manifest is unavailable");
  }
  const manifest = parseVerifiedWorkspaceManifest(
    await manifestResult.stdout(),
    trustedManifest,
  );

  const repositories: InspectedWorkspaceRepository[] = [];
  const headShas: string[] = [];
  for (const repo of manifest.repositories) {
    const status = await sandbox.runCommand("git", [
      "-C",
      repo.localPath,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status.exitCode !== 0 || (await status.stdout()).trim().length > 0) {
      throw new Error(`Run Workspace is not clean for ${repo.provider}:${repo.repoPath}`);
    }

    const head = await sandbox.runCommand("git", [
      "-C",
      repo.localPath,
      "rev-parse",
      "HEAD",
    ]);
    const headSha = head.exitCode === 0 ? (await head.stdout()).trim() : "";
    if (!headSha) {
      throw new Error(`Run Workspace HEAD is unavailable for ${repo.provider}:${repo.repoPath}`);
    }
    headShas.push(headSha);
    repositories.push({
      provider: repo.provider,
      repoPath: repo.repoPath,
      ...(repo.preAgentSha ? { preAgentSha: repo.preAgentSha } : {}),
      headSha,
    });
  }

  return {
    fingerprint: fingerprintWorkspaceState(trustedManifest, headShas),
    repositories,
  };
}
inspectWorkspaceForGateStep.maxRetries = 0;

function hasApplicableChecks(
  config: PrePrCheckConfig,
  repositories: readonly InspectedWorkspaceRepository[],
): boolean {
  const configured = new Set(
    config.repositories.map((repo) => `${repo.provider}:${repo.repoPath}`),
  );
  return repositories.some(
    (repo) =>
      configured.has(`${repo.provider}:${repo.repoPath}`) &&
      (!repo.preAgentSha || repo.preAgentSha !== repo.headSha),
  );
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}
