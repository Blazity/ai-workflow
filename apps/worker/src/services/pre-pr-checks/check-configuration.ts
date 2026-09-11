/**
 * The stored pre-PR check configuration, as the dashboard reads and edits it.
 *
 * The store below takes a connection and appends rows; this decides what an
 * edit request means: whether the submitted configuration parses, whether it
 * names an environment variable this worker is allowed to forward, and whether
 * the editor's concurrency token still matches what is stored. The route above
 * turns the three outcomes into a status code and nothing else.
 */
import type {
  PrePrCheckConfigVersion,
  PrePrChecksResponse,
} from "@shared/contracts";

import {
  PRE_PR_ALLOWED_ENV_VAR,
  allowedRepoEnvNames,
} from "../../engine/steps/pre-pr-checks-runner.js";
import {
  describePrePrCheckIssues,
  repoScriptsConfigSchema,
  type PrePrCheckConfig,
  type RepoScriptsConfig,
} from "../../pre-pr-checks/config.js";
import {
  getConnectedCurrentPrePrCheckConfig,
  listConnectedPrePrCheckConfigVersions,
  restoreConnectedPrePrCheckConfig,
  saveConnectedPrePrCheckConfig,
  serializePrePrCheckConfigVersion,
} from "../../pre-pr-checks/store.js";
import {
  getConnectedDashboardUserLabel,
  type DashboardRole,
} from "../auth/index.js";

/** Who is editing, as the store's audit trail records them. */
export interface PrePrCheckEditor {
  actorRole: DashboardRole;
  actorId: string;
}

/** What a save request became. Only the first of these is a 200. */
export type PrePrCheckSaveOutcome =
  | { kind: "saved"; version: PrePrCheckConfigVersion }
  | { kind: "invalid"; message: string }
  | { kind: "version_conflict"; latestVersion: number };

/**
 * Reject a save that names an environment variable the operator has not
 * allowlisted, and say which names those are.
 *
 * A courtesy, not the gate. The real enforcement is at batch start
 * (resolveRepoEnv), and it has to stay there: an allowlist shrunk after this
 * save would otherwise let a stored configuration keep forwarding a variable
 * the operator has since withdrawn. What this adds is a save-time answer, so
 * the dashboard can say "not allowlisted" while someone is typing the name
 * instead of a run failing an hour later.
 *
 * Names only, never values. This message is returned over HTTP and rendered in
 * a browser; the value the name resolves to is exactly what must not travel.
 */
function describeDisallowedEnvNames(config: RepoScriptsConfig): string | null {
  const allowed = allowedRepoEnvNames();
  // Per repository entry, not a flat set of names. A save is a whole config, so
  // the person fixing it needs to know WHERE to look, and a run that reads
  // "NPM_TOKEN is not allowlisted" against nine repositories has been told
  // nothing it can act on.
  const offenders = config.repositories
    .map((repository) => ({
      repoPath: repository.repoPath,
      names: (repository.env ?? []).filter((name) => !allowed.has(name)),
    }))
    .filter((entry) => entry.names.length > 0);
  if (offenders.length === 0) return null;
  const where = offenders
    .map((entry) => `${entry.repoPath} (${entry.names.join(", ")})`)
    .join("; ");
  // Deliberately not limited to names this save introduced. Storage is
  // verbatim, so every save asserts the whole config; re-persisting a known
  // violation because it was already there would make the allowlist advisory.
  const lead =
    allowed.size === 0
      ? `no environment variables are allowlisted on this worker, so nothing in env can be forwarded`
      : `these environment variable names are not allowlisted on this worker`;
  return (
    `Invalid config: ${lead}: ${where}. Either remove the name from the ` +
    `repository's env list, or have an operator add it to ${PRE_PR_ALLOWED_ENV_VAR} ` +
    `on the worker and redeploy. Names only are shown here; no value is ever read ` +
    `or returned by this endpoint.`
  );
}

/** Everything the editor screen loads: the history and the deployment state. */
export async function readPrePrChecksOverview(): Promise<PrePrChecksResponse> {
  const versions = (await listConnectedPrePrCheckConfigVersions()).map(
    serializePrePrCheckConfigVersion,
  );
  return {
    current: versions[0] ?? null,
    versions,
    // The runner's own parse, never a second one: the editor offering a name
    // the batch would refuse is the drift this shares the helper to avoid.
    // Sorted, because the operator's variable is a comma separated string
    // whose order says nothing, and a list that reshuffles between reads
    // makes the picker jump.
    allowedEnv: [...allowedRepoEnvNames()].sort(),
  };
}

export async function savePrePrChecksConfiguration(input: {
  editor: PrePrCheckEditor;
  /** The submitted value, unparsed, exactly as it arrived. */
  config: unknown;
  /** The editor's concurrency token, unparsed: only a number is honoured. */
  baseVersion: unknown;
}): Promise<PrePrCheckSaveOutcome> {
  // Validated against the repository scripts contract, which accepts both the
  // named-group shape and the legacy flat commands shape, so an editor that
  // still round-trips the old shape keeps saving.
  const parsed = repoScriptsConfigSchema.safeParse(input.config);
  if (!parsed.success || input.config === undefined) {
    return {
      kind: "invalid",
      message: parsed.success
        ? "Invalid config: config is required."
        : `Invalid config: ${describePrePrCheckIssues(parsed.error)}`,
    };
  }
  const envRejection = describeDisallowedEnvNames(parsed.data);
  if (envRejection) {
    return { kind: "invalid", message: envRejection };
  }
  // Optimistic concurrency, and only when the editor asked for it. A screen
  // opened before a colleague saved holds a config built on THEIR predecessor,
  // and the store is append-only, so saving it would not merge anything: it
  // would publish an older configuration as the newest one, with nothing on
  // any surface saying so.
  //
  // Only a number counts as present. Absent is every dashboard deployed
  // before this field, and those saves keep going through unconditionally.
  if (typeof input.baseVersion === "number") {
    // 0 when nothing is stored, which is the token an editor that loaded an
    // empty screen holds. Read rather than locked: neon-http has no
    // transactions, so this closes the window an operator can actually hit
    // (a stale tab minutes old), not the microseconds between this read and
    // the insert below.
    const latestVersion = (await getConnectedCurrentPrePrCheckConfig())?.version ?? 0;
    if (latestVersion !== input.baseVersion) {
      return { kind: "version_conflict", latestVersion };
    }
  }
  const saved = await saveConnectedPrePrCheckConfig({
    actorRole: input.editor.actorRole,
    actorId: input.editor.actorId,
    actorLabel: await getConnectedDashboardUserLabel(input.editor.actorId),
    // The RAW submitted shape, deliberately not parsed.data.
    //
    // repoScriptsConfigSchema normalizes on the way through: it fills setup
    // and env defaults and rewrites a legacy flat `commands` entry into
    // groups.checks. Storing that normalized value would change the bytes the
    // publication gate fingerprints, and the gate hashes the stored
    // configuration, so every recorded gate would be invalidated by a save
    // that changed nothing an operator typed. Normalization belongs at the
    // engine boundary, where runPrePrChecksWithFixes parses this value again.
    //
    // Asserted into the store input type, which still declares the worker's
    // deprecated legacy PrePrCheckConfig. Storage is verbatim jsonb, so the
    // assertion bridges declarations only, never bytes; widening the store row
    // type to the shared contract is deliberately not this cluster's change.
    config: input.config as PrePrCheckConfig,
  });
  return { kind: "saved", version: serializePrePrCheckConfigVersion(saved) };
}

/** Republish a stored version as the newest one, audited to the editor. */
export async function restorePrePrChecksConfiguration(input: {
  editor: PrePrCheckEditor;
  version: number;
}): Promise<PrePrCheckConfigVersion> {
  const restored = await restoreConnectedPrePrCheckConfig({
    actorRole: input.editor.actorRole,
    actorId: input.editor.actorId,
    actorLabel: await getConnectedDashboardUserLabel(input.editor.actorId),
    version: input.version,
  });
  return serializePrePrCheckConfigVersion(restored);
}
