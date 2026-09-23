/**
 * Reading and changing the stored settings, in the shapes the HTTP surface
 * answers with.
 *
 * The handlers above this file do authentication, status codes and nothing
 * else: which keys exist, what a value may be, and what a change records are
 * all decided here and in the registry, so the MCP tools a later plan adds
 * cannot end up with a second, looser answer to the same questions.
 *
 * "Which keys exist" is this build's whole list, `settingDefinitions` in
 * `@integrations/registry`: core's registry and every setting an integration
 * declares, so an integration's setting is read, written, validated and
 * versioned here like any of core's.
 */
import { settingDefinition, settingDefinitions } from "@integrations/registry";
import {
  SETTING_LIST_ENTRY_RULE,
  resolveSettingWithoutStoredRow,
  validateSettingsPatch,
  type SettingValidationIssue,
  type SettingValue,
  type SettingsConflictView,
  type SettingsEntryView,
  type SettingsPatchResponse,
  type SettingsReadResponse,
  type SettingsSnapshot,
  type SettingsVersionView,
  type SettingsVersionsResponse,
} from "@shared/contracts";
import { getConnectedDashboardUserLabels } from "../../db/repositories/auth.js";
import {
  latestConnectedSettingsVersions,
  listConnectedSettingsVersions,
  writeManyConnectedSettings,
  type SettingsVersionRow,
} from "../../db/repositories/settings.js";
import { settingsEnvironment } from "../../infra/settings-environment.js";
import { loadSettingsResolution, type SettingsResolution } from "./snapshot.js";

/** How many past changes of one key the history answers with. */
const HISTORY_LIMIT = 50;

/**
 * A patch the registry refused. Carries every offending key rather than the
 * first, so a form that submits a whole group hears about all of them at once.
 */
export class SettingsValidationError extends Error {
  readonly issues: SettingValidationIssue[];

  constructor(issues: SettingValidationIssue[]) {
    // The keyed list is what the dashboard maps to its fields; a refusal whose
    // fix is not obvious from its code carries the sentence that says it, the
    // same one the dashboard shows, so an MCP caller reads it too.
    const listEntry = issues.some((issue) => issue.reason === "list_entry_invalid");
    super(
      `Invalid settings: ${issues
        .map((issue) => `${issue.key} (${issue.reason})`)
        .join(", ")}${listEntry ? `. ${SETTING_LIST_ENTRY_RULE}` : ""}`,
    );
    this.name = "SettingsValidationError";
    this.issues = issues;
  }
}

/**
 * A settings write refused because a key it touches was changed by somebody
 * else after the caller read it. Nothing of the write was stored. Carries each
 * refused key as it stands now, so a surface can show what won without a
 * second read.
 */
export class SettingsVersionConflictError extends Error {
  readonly conflicts: SettingsConflictView[];

  constructor(conflicts: SettingsConflictView[]) {
    super(
      `Changed since you read it: ${conflicts
        .map((conflict) => `${conflict.key} (now version ${conflict.currentVersion})`)
        .join(", ")}. Nothing was stored. Read the setting again and send its current version to overwrite.`,
    );
    this.name = "SettingsVersionConflictError";
    this.conflicts = conflicts;
  }
}

/** Who each writer is, by the id the rows store. */
export type ActorLabels = ReadonlyMap<string, string>;

/** The people behind these rows, in one read. A writer that is not a user
 *  ("migration", a deleted account) is simply absent from the answer. */
export function actorLabelsFor(rows: readonly SettingsVersionRow[]): Promise<ActorLabels> {
  return getConnectedDashboardUserLabels(rows.map((row) => row.actor));
}

/** One recorded change, as every settings surface publishes it. Exported so a
 *  second reader of the same rows (the paged history) maps them the same way
 *  rather than growing its own copy. */
export function versionView(row: SettingsVersionRow, labels: ActorLabels): SettingsVersionView {
  return {
    id: row.id,
    key: row.key,
    previousValue: row.previousValue,
    newValue: row.newValue,
    actor: row.actor,
    actorLabel: labels.get(row.actor) ?? row.actor,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

function entryViews(
  resolution: SettingsResolution,
  latest: SettingsVersionRow[],
  labels: ActorLabels,
): SettingsEntryView[] {
  const lastByKey = new Map(latest.map((row) => [row.key, versionView(row, labels)]));
  const values = resolution.snapshot as unknown as Readonly<Record<string, SettingValue>>;
  return settingDefinitions.map((definition) => ({
    key: definition.key,
    value: values[definition.key] ?? null,
    default: definition.default,
    source: resolution.sources.get(definition.key) ?? "default",
    group: definition.group,
    description: definition.description,
    appliesToRunsInFlight: definition.appliesToRunsInFlight,
    requiresRedeploy: definition.requiresRedeploy,
    lastVersion: lastByKey.get(definition.key) ?? null,
    // The same rule the reset records as the value that takes over, so what
    // the confirmation promised is what the history then shows.
    fallback:
      resolveSettingWithoutStoredRow(definition.key, settingsEnvironment, settingDefinition) ??
      undefined,
  }));
}

/** Every setting, resolved, with the change that last touched it. */
export async function readSettings(): Promise<SettingsReadResponse> {
  const [resolution, latest] = await Promise.all([
    loadSettingsResolution(),
    latestConnectedSettingsVersions(),
  ]);
  return { settings: entryViews(resolution, latest, await actorLabelsFor(latest)) };
}

/** The conflict each stale key is answered with: the key as it stands now. */
export async function settingsConflicts(
  stale: readonly { key: string; currentVersion: number }[],
  expected: (key: string) => number,
): Promise<SettingsConflictView[]> {
  const current = new Map((await readSettings()).settings.map((entry) => [entry.key, entry]));
  return stale.flatMap((row) => {
    const setting = current.get(row.key);
    // Every stale key was a registry key the write validated, and the read
    // enumerates the registry, so this cannot be missing.
    return setting
      ? [{ key: row.key, expectedVersion: expected(row.key), currentVersion: row.currentVersion, setting }]
      : [];
  });
}

/** One key's recorded changes, newest first. A key that is not a setting is
 *  refused rather than answered with an empty history, so a typo in a link is
 *  visible instead of looking like "nothing ever changed here". */
export async function readSettingsHistory(
  key: string,
): Promise<SettingsVersionsResponse> {
  if (!settingDefinition(key)) {
    throw new SettingsValidationError([{ key, reason: "unknown_key" }]);
  }
  const rows = await listConnectedSettingsVersions(key, HISTORY_LIMIT);
  const labels = await actorLabelsFor(rows);
  return { versions: rows.map((row) => versionView(row, labels)) };
}

/**
 * The bounds no single key can check on its own.
 *
 * THIS IS THE ONLY PLACE THE PAIR IS ENFORCED. The rule is that the MCP result
 * limit stays at or below the request limit. It used to be a boot-time
 * refinement in `runtime-env.ts`, and that is gone: both keys are ordinary
 * stored settings now (`packages/contracts/settings-registry.ts:287` and
 * `:297`), `runtime-env.ts` does not mention either of them, and nothing
 * refuses to start on a bad pair. So a write accepted here is a write the
 * deployment will run with, and removing this check removes the rule.
 * `settings-registry.ts:302` states the rule in a description only, which
 * enforces nothing. The pair is judged as it would stand after the write
 * (the patched value where there is one, the value in force otherwise), and
 * only when the patch touches one of the two, so an unrelated change is never
 * refused for a state it did not create.
 */
function crossFieldIssues(
  patch: Readonly<Record<string, unknown>>,
  inForce: SettingsSnapshot,
): SettingValidationIssue[] {
  const touchesPair =
    "MCP_MAX_RESULT_BYTES" in patch || "MCP_MAX_REQUEST_BYTES" in patch;
  if (!touchesPair) return [];
  const resultBytes =
    "MCP_MAX_RESULT_BYTES" in patch
      ? patch.MCP_MAX_RESULT_BYTES
      : inForce.MCP_MAX_RESULT_BYTES;
  const requestBytes =
    "MCP_MAX_REQUEST_BYTES" in patch
      ? patch.MCP_MAX_REQUEST_BYTES
      : inForce.MCP_MAX_REQUEST_BYTES;
  if (
    typeof resultBytes === "number" &&
    typeof requestBytes === "number" &&
    resultBytes > requestBytes
  ) {
    return [{ key: "MCP_MAX_RESULT_BYTES", reason: "above_request_limit" }];
  }
  return [];
}

/**
 * Store a patch, recording who changed what and why.
 *
 * Validation runs before anything is written, so a patch with one bad key
 * changes nothing at all rather than half of what was asked for. The write
 * itself is one statement in the repository tier; the snapshot is read back
 * afterwards because a statement cannot see its own writes.
 *
 * `expectedVersions` is the caller's concurrency token per key (see
 * `settingsPatchRequestSchema`). A stale key refuses the whole patch with
 * `SettingsVersionConflictError`; without the token the last write wins.
 */
export async function updateSettings(input: {
  patch: Readonly<Record<string, unknown>>;
  actor: string;
  reason: string;
  expectedVersions?: Readonly<Record<string, number>>;
}): Promise<SettingsPatchResponse> {
  const issues = validateSettingsPatch(input.patch, settingDefinition);
  if (issues.length > 0) throw new SettingsValidationError(issues);

  const inForce = await loadSettingsResolution();
  const crossField = crossFieldIssues(input.patch, inForce.snapshot);
  if (crossField.length > 0) throw new SettingsValidationError(crossField);

  const written = await writeManyConnectedSettings({
    patch: input.patch as Readonly<Record<string, SettingValue>>,
    actor: input.actor,
    reason: input.reason,
    expectedVersions: input.expectedVersions,
  });
  if (written.stale.length > 0) {
    throw new SettingsVersionConflictError(
      await settingsConflicts(written.stale, (key) => input.expectedVersions?.[key] ?? 0),
    );
  }
  const [resolution, latest] = await Promise.all([
    loadSettingsResolution(),
    latestConnectedSettingsVersions(),
  ]);
  const labels = await actorLabelsFor([...latest, ...written.versions]);
  return {
    settings: entryViews(resolution, latest, labels),
    versions: written.versions.map((row) => versionView(row, labels)),
  };
}
