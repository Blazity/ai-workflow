import type { PrePrCheckConfig } from "../pre-pr-checks/config.js";
import {
  WORKSPACE_GATE_NOT_RECORDED_AFTER_FAILURE_MESSAGE,
  WORKSPACE_GATE_NOT_RECORDED_MESSAGE,
  WORKSPACE_NOT_VERIFIABLE_MESSAGE,
} from "../workflow-definition/interpreter.js";
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

/**
 * What a run's repository scripts left in a repository's tree, exactly as the
 * script blocks publish it (agent.ts RepositoryScriptsOutput.dirtied).
 *
 * Structural rather than imported, so the gate keeps no dependency on the block
 * layer that produces it: this file is reached from the publication boundary,
 * which must not grow an import edge to the engine.
 */
export interface WorkspaceScriptDrift {
  /** provider:repoPath, the same key the script output uses. */
  repo: string;
  /** Tracked files this run's own script commands modified. */
  files: string[];
  /** Tracked files already modified when the scripts started: the agent's
   *  uncommitted work, which the scripts never touched and never restore. */
  preExisting: string[];
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
    /**
     * The one fragment of this failure that must reach the operator whatever
     * else is clamped: who dirtied the tree.
     *
     * Carried beside the message rather than inside it because the message is
     * clamped twice on its way out (bounded here, then head-and-tail clamped
     * into a 160-character snippet), and both cuts land in the middle, which is
     * where an appended attribution sits. The publication boundary hands this
     * to `executionError` as `evidence.cause`, and derivation gives an isolated
     * cause priority over the composed whole precisely so it survives.
     */
    readonly attribution?: string,
  ) {
    super(message);
    this.name = "WorkspaceGateError";
  }
}

export function invalidateWorkspaceGate(state: WorkspaceGateState): void {
  state.prePrGate = null;
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
  /** What this run's repository scripts left behind, when a script block ran.
   *  It is the difference between "someone left files modified" and "the
   *  formatter group you configured with restoreTree false did it", which are
   *  answered by two different people. */
  dirtied?: readonly WorkspaceScriptDrift[];
  /** Whether this run's repository scripts reported failures. It only picks
   *  which missing-gate sentence is true, never whether the gate is required. */
  scriptsFailed?: boolean;
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
  } catch (error) {
    // Inspection fails for materially different reasons (the sandbox is gone,
    // the manifest file is missing, the on-disk manifest disagrees with the
    // trusted one), and swallowing them left a production failure whose only
    // message named the boundary rather than the cause. Carry the reason, and
    // bound it so a provider error object cannot become the run status.
    const reason = error instanceof Error ? error.message : String(error);
    const attribution = attributeScriptDrift(input.dirtied);
    // The attribution is appended here AND carried structurally. Appended, so
    // the raw message read in a log is complete; carried, because this text is
    // clamped twice downstream (bounded here, then head-and-tail clamped into a
    // 160-character snippet) and both cuts land exactly where an appended
    // sentence sits. Only the structural copy is guaranteed to reach an
    // operator, which is why it leads with the culprit and not with the
    // pre-existing dirt.
    throw new WorkspaceGateError(
      "workspace_unverifiable",
      `${WORKSPACE_NOT_VERIFIABLE_MESSAGE} ${reason.slice(0, 200)}${attribution}`,
      attribution.trim() || undefined,
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
    // The message is the interpreter's, not this file's. It becomes the
    // execution error's detail verbatim, and derivation only returns it alone,
    // rather than folded into the generic checks sentence, when the detail and
    // the lead are the same string. See WORKSPACE_GATE_NOT_RECORDED_MESSAGE.
    throw new WorkspaceGateError(
      "missing_gate",
      // "may have passed" is only true while nothing says otherwise. Printed
      // above a list of failing commands in the same ticket comment it reads as
      // the product contradicting itself, so the caller's own evidence decides
      // which of the two leads fires.
      input.scriptsFailed
        ? WORKSPACE_GATE_NOT_RECORDED_AFTER_FAILURE_MESSAGE
        : WORKSPACE_GATE_NOT_RECORDED_MESSAGE,
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
  const { fingerprintWorkspaceState } = await import(
    "./workspace-gate-fingerprint.js"
  );
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  const manifestResult = await sandbox.runCommand("cat", [WORKSPACE_MANIFEST_PATH]);
  if (manifestResult.exitCode !== 0) {
    const stderr = (await manifestResult.stderr()).trim().slice(0, 120);
    throw new Error(
      `Run Workspace manifest is unavailable (exit ${manifestResult.exitCode}${stderr ? `: ${stderr}` : ""})`,
    );
  }
  const manifest = parseVerifiedWorkspaceManifest(
    await manifestResult.stdout(),
    trustedManifest,
  );

  const repositories: InspectedWorkspaceRepository[] = [];
  const headShas: string[] = [];
  for (const repo of manifest.repositories) {
    // Research and implementation now run inside the shared code workspace, so
    // agent phases leave untracked build/test/scratch artifacts behind. Those
    // never enter the publication bundle (it exports commit ranges), so ignore
    // untracked entries and fail only on tracked modifications (staged or
    // unstaged) that would be lost if not committed. This matches the read-check
    // tolerance in repository-promotion.ts and trusted-workspace-publisher.ts.
    const status = await sandbox.runCommand("git", [
      "-C",
      repo.localPath,
      "status",
      "--porcelain=v1",
      "--untracked-files=no",
    ]);
    const statusOut = status.exitCode === 0 ? await status.stdout() : "";
    if (status.exitCode !== 0 || statusOut.trim().length > 0) {
      throw new Error(
        `Run Workspace is not clean for ${repo.provider}:${repo.repoPath}${describeDrift(statusOut)}`,
      );
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

/**
 * How many drifted paths the failure names before it starts counting.
 *
 * A bound and not a full list: this text becomes the run's failure reason,
 * which every surface clamps, and a formatter run over a large repository can
 * leave hundreds of modified files. Ten is enough to recognise which script
 * did it; the count carries the rest.
 */
const DRIFTED_FILES_NAMED = 10;

/**
 * The tracked paths a porcelain listing reports, oldest git spelling included.
 *
 * The two-character XY status plus its separator is dropped so an operator
 * reads paths rather than status codes, and a rename reports its destination,
 * which is the path that exists on disk now. Quoted paths (a name with a space
 * or a non-ASCII byte) are left exactly as git wrote them: unquoting them here
 * would produce a path that disagrees with what `git status` shows.
 */
function driftedFiles(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const path = line.length > 3 ? line.slice(3) : line.trim();
      const renamed = path.split(" -> ");
      return (renamed[renamed.length - 1] ?? "").trim();
    })
    .filter((path) => path.length > 0);
}

/**
 * Name what drifted, so the failure is actionable without a sandbox.
 *
 * Before this the boundary said only that the workspace was not clean, which
 * an operator cannot act on: the sandbox is gone by the time they read it, so
 * there is no way left to ask which files it meant. The run's own script
 * groups can leave tracked files behind on purpose (a group with restoreTree
 * false), and knowing WHICH files is what separates that from an agent that
 * forgot to commit.
 */
function describeDrift(porcelain: string): string {
  const files = driftedFiles(porcelain);
  if (files.length === 0) return "";
  const named = files.slice(0, DRIFTED_FILES_NAMED);
  const remaining = files.length - named.length;
  return `: ${named.join(", ")}${remaining > 0 ? ` and ${remaining} more` : ""}`;
}

/**
 * Say who dirtied the tree, when the run's own script output knows.
 *
 * The listing above names WHAT git sees; this names WHO put it there, and the
 * two are not the same question. A group configured with restoreTree false
 * leaves tracked files behind by design, so those paths are a configuration
 * decision an operator can revisit. The agent's own uncommitted work is a
 * different failure with a different fix, and reverting it would destroy the
 * run's output. Reporting the two as one undifferentiated list is what made
 * this boundary unactionable.
 *
 * Empty for every run with no script block, and for a script run that modified
 * nothing: a sentence claiming zero files would be noise on the failures this
 * has nothing to say about.
 */
function attributeScriptDrift(
  dirtied: readonly WorkspaceScriptDrift[] | undefined,
): string {
  if (!dirtied || dirtied.length === 0) return "";
  const sentences: string[] = [];
  for (const repo of dirtied) {
    if (repo.files.length > 0) {
      sentences.push(
        `Repository scripts modified ${countedFiles(repo.files)} in ${repo.repo}${listFiles(repo.files)}.`,
      );
    }
    if (repo.preExisting.length > 0) {
      sentences.push(
        `${countedFiles(repo.preExisting)} in ${repo.repo} ${
          repo.preExisting.length === 1 ? "was" : "were"
        } already modified before the scripts ran${listFiles(repo.preExisting)}.`,
      );
    }
  }
  return sentences.length > 0 ? ` ${sentences.join(" ")}` : "";
}

function countedFiles(files: readonly string[]): string {
  return `${files.length} tracked file${files.length === 1 ? "" : "s"}`;
}

/** Bounded here and unbounded in the ticket comment, on purpose: this string
 *  becomes a run status the surfaces around it clamp, and that comment is the
 *  one surface with room for the whole list (agent.ts renderRepositoryScriptDrift). */
function listFiles(files: readonly string[]): string {
  const named = files.slice(0, DRIFTED_FILES_NAMED);
  const remaining = files.length - named.length;
  return `: ${named.join(", ")}${remaining > 0 ? ` and ${remaining} more` : ""}`;
}

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
