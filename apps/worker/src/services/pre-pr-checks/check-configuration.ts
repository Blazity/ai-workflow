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
} from "../../engine/pre-pr-checks/config.js";
import {
  getConnectedCurrentPrePrCheckConfig,
  listConnectedPrePrCheckConfigVersions,
  restoreConnectedPrePrCheckConfig,
  saveConnectedPrePrCheckConfig,
  serializePrePrCheckConfigVersion,
} from "../../engine/pre-pr-checks/store.js";
import {
  getConnectedCurrentCheckConfiguration,
  getConnectedRepositoryWithProfileByPath,
  upsertConnectedRepositoryProfile,
} from "../../db/repositories/repository-catalog.js";
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

/**
 * Fan a whole-configuration save out to one profile version per repository.
 *
 * The screen above still edits every repository at once, and the catalog stores
 * them one at a time, so this is the translation between the two for as long as
 * that screen exists. Each iteration is a single-statement upsert in the
 * repository tier; the awaits are sequential and over DIFFERENT repositories,
 * which is the one case a loop of writes is honest here. Nothing in it is a
 * multi-row change that a transaction would have to make atomic: a save that
 * fails halfway leaves the repositories it reached configured and the rest as
 * they were, which is exactly what re-saving repairs.
 *
 * The second loop is the half that is easy to miss. Removing a repository from
 * this screen used to remove its checks, because the screen WAS the
 * configuration; with profiles, a repository dropped from the submitted config
 * would keep the profile it had and keep running its commands. So a repository
 * that currently has script groups and is not named by this save has them
 * dropped, as a new version with the actor and a reason, rather than silently
 * surviving.
 */
async function fanOutRepositoryProfiles(input: {
  config: RepoScriptsConfig;
  /** The raw submitted entries, positionally aligned with `config.repositories`,
   *  so what is stored is the bytes the operator sent and not the normalized
   *  value, exactly as the global blob stores them. */
  rawRepositories: unknown[];
  actorId: string;
  actorLabel: string;
  reason: string;
}): Promise<void> {
  const named = new Set<string>();
  for (const [index, repository] of input.config.repositories.entries()) {
    const raw = input.rawRepositories[index];
    const entry =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : (repository as unknown as Record<string, unknown>);
    const gateGroups = Array.isArray(entry.gateGroups)
      ? (entry.gateGroups as string[])
      : (repository.gateGroups ?? null);
    named.add(`${repository.provider}:${repository.repoPath.toLowerCase()}`);
    if (await profileAlreadyMatches({ repository, entry, gateGroups })) continue;
    await upsertConnectedRepositoryProfile({
      provider: repository.provider,
      path: repository.repoPath,
      // No description, rules or relationships: this screen does not own them,
      // and passing empties would erase whatever the Repositories screen holds.
      scriptGroups: entry,
      gateGroups,
      actorId: input.actorId,
      actorLabel: input.actorLabel,
      reason: input.reason,
      // A save made by a person here is a person's row, the same as one made on
      // the Repositories screen. `migrated` is reserved for what the build-time
      // seed lifted out of the old blob with nobody watching.
      source: "manual",
    });
  }
  const current = await getConnectedCurrentCheckConfiguration();
  for (const key of Object.keys(current.repositoryVersions)) {
    if (named.has(key)) continue;
    const [provider, ...rest] = key.split(":");
    const path = rest.join(":");
    if (!provider || !path) continue;
    await upsertConnectedRepositoryProfile({
      provider,
      path,
      scriptGroups: null,
      gateGroups: null,
      actorId: input.actorId,
      actorLabel: input.actorLabel,
      reason: "removed from the repository scripts configuration",
    });
  }
}

/**
 * Whether this save changes anything the checks would execute for a repository.
 *
 * This is what keeps a legacy save of repository B from failing a run in flight
 * on repository A. The screen submits the WHOLE configuration on every save, so
 * without this every repository named by it would get a new profile version and
 * a new checks version on every click, and the per-repository comparison at
 * Finalize would be no more precise than the global counter it replaced.
 *
 * Compared as canonical JSON rather than by identity: the entry is stored as
 * jsonb, which has already normalized whitespace and duplicate keys out of it,
 * so the only honest question is whether the two values are the same value.
 */
async function profileAlreadyMatches(input: {
  repository: RepoScriptsConfig["repositories"][number];
  entry: Record<string, unknown>;
  gateGroups: string[] | null;
}): Promise<boolean> {
  const found = await getConnectedRepositoryWithProfileByPath({
    provider: input.repository.provider,
    path: input.repository.repoPath,
  });
  const profile = found?.profile;
  if (!profile?.scriptGroups) return false;
  return (
    canonicalJson(profile.scriptGroups) === canonicalJson(input.entry) &&
    canonicalJson(profile.gateGroups ?? null) === canonicalJson(input.gateGroups)
  );
}

/** Key-order-independent JSON, because jsonb round trips keys in its own order
 *  and a plain stringify would report every stored profile as different. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * Everything the editor screen loads: the history and the deployment state.
 *
 * `current.config` is composed out of the per-repository profiles, because
 * those are what a run executes; the history below it stays the global blob's,
 * which is the only place a whole-configuration timeline exists and which the
 * save path keeps appending to until the Repositories page replaces this
 * screen. The two agree on every save made here; a profile edited through the
 * catalog moves the composed configuration and not the history, which is the
 * point of the catalog.
 */
export async function readPrePrChecksOverview(): Promise<PrePrChecksResponse> {
  const versions = (await listConnectedPrePrCheckConfigVersions()).map(
    serializePrePrCheckConfigVersion,
  );
  const composed = await getConnectedCurrentCheckConfiguration();
  const head = versions[0] ?? null;
  const current =
    composed.config.repositories.length === 0
      ? head
      : {
          version: composed.version ?? 0,
          config: composed.config,
          createdAt:
            composed.changedAt?.toISOString() ?? head?.createdAt ?? new Date(0).toISOString(),
          createdById: composed.changedById ?? head?.createdById ?? "catalog",
          createdByLabel: composed.changedByLabel ?? head?.createdByLabel ?? "repository catalog",
          restoredFromVersion: head?.restoredFromVersion ?? null,
        };
  return {
    current,
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
  const actorLabel = await getConnectedDashboardUserLabel(input.editor.actorId);
  const saved = await saveConnectedPrePrCheckConfig({
    actorRole: input.editor.actorRole,
    actorId: input.editor.actorId,
    actorLabel,
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
  await fanOutRepositoryProfiles({
    config: parsed.data,
    rawRepositories: rawRepositoriesOf(input.config),
    actorId: input.editor.actorId,
    actorLabel,
    reason: `repository scripts save (configuration v${saved.version})`,
  });
  return { kind: "saved", version: serializePrePrCheckConfigVersion(saved) };
}

/** The submitted repository entries, unparsed, or an empty list when the body
 *  was not shaped like one. Positional only: the schema preserves order, so
 *  entry i of the parse is entry i of the submission. */
function rawRepositoriesOf(config: unknown): unknown[] {
  if (config === null || typeof config !== "object") return [];
  const repositories = (config as { repositories?: unknown }).repositories;
  return Array.isArray(repositories) ? repositories : [];
}

/** Republish a stored version as the newest one, audited to the editor. */
export async function restorePrePrChecksConfiguration(input: {
  editor: PrePrCheckEditor;
  version: number;
}): Promise<PrePrCheckConfigVersion> {
  const actorLabel = await getConnectedDashboardUserLabel(input.editor.actorId);
  const restored = await restoreConnectedPrePrCheckConfig({
    actorRole: input.editor.actorRole,
    actorId: input.editor.actorId,
    actorLabel,
    version: input.version,
  });
  // A restore republishes a stored configuration as the newest one, so it has
  // to reach the profiles too: without this the screen would show the restored
  // configuration while every run kept executing the one it replaced.
  const parsed = repoScriptsConfigSchema.safeParse(restored.config);
  if (parsed.success) {
    await fanOutRepositoryProfiles({
      config: parsed.data,
      rawRepositories: rawRepositoriesOf(restored.config),
      actorId: input.editor.actorId,
      actorLabel,
      reason: `repository scripts restore of v${input.version}`,
    });
  }
  return serializePrePrCheckConfigVersion(restored);
}
