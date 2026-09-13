/**
 * Reading and changing the stored settings, in the shapes the HTTP surface
 * answers with.
 *
 * The handlers above this file do authentication, status codes and nothing
 * else: which keys exist, what a value may be, and what a change records are
 * all decided here and in the registry, so the MCP tools a later plan adds
 * cannot end up with a second, looser answer to the same questions.
 */
import {
  SETTINGS_REGISTRY,
  findSettingDefinition,
  validateSettingsPatch,
  type SettingValidationIssue,
  type SettingValue,
  type SettingsEntryView,
  type SettingsPatchResponse,
  type SettingsReadResponse,
  type SettingsSnapshot,
  type SettingsVersionView,
  type SettingsVersionsResponse,
} from "@shared/contracts";
import {
  latestConnectedSettingsVersions,
  listConnectedSettingsVersions,
  writeManyConnectedSettings,
  type SettingsVersionRow,
} from "../../db/repositories/settings.js";
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
    super(
      `Invalid settings: ${issues
        .map((issue) => `${issue.key} (${issue.reason})`)
        .join(", ")}`,
    );
    this.name = "SettingsValidationError";
    this.issues = issues;
  }
}

/** One recorded change, as every settings surface publishes it. Exported so a
 *  second reader of the same rows (the paged history) maps them the same way
 *  rather than growing its own copy. */
export function versionView(row: SettingsVersionRow): SettingsVersionView {
  return {
    id: row.id,
    key: row.key,
    previousValue: row.previousValue,
    newValue: row.newValue,
    actor: row.actor,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

function entryViews(
  resolution: SettingsResolution,
  latest: SettingsVersionRow[],
): SettingsEntryView[] {
  const lastByKey = new Map(latest.map((row) => [row.key, versionView(row)]));
  return SETTINGS_REGISTRY.map((definition) => ({
    key: definition.key,
    value: resolution.snapshot[definition.key],
    default: definition.default,
    source: resolution.sources.get(definition.key) ?? "default",
    group: definition.group,
    description: definition.description,
    appliesToRunsInFlight: definition.appliesToRunsInFlight,
    // Through the lookup rather than off `definition`: the registry is `as
    // const`, so a key without this optional flag does not carry the property
    // in its literal type at all.
    requiresRedeploy: findSettingDefinition(definition.key)?.requiresRedeploy,
    lastVersion: lastByKey.get(definition.key) ?? null,
  }));
}

/** Every setting, resolved, with the change that last touched it. */
export async function readSettings(): Promise<SettingsReadResponse> {
  const [resolution, latest] = await Promise.all([
    loadSettingsResolution(),
    latestConnectedSettingsVersions(),
  ]);
  return { settings: entryViews(resolution, latest) };
}

/** One key's recorded changes, newest first. A key that is not a setting is
 *  refused rather than answered with an empty history, so a typo in a link is
 *  visible instead of looking like "nothing ever changed here". */
export async function readSettingsHistory(
  key: string,
): Promise<SettingsVersionsResponse> {
  if (!findSettingDefinition(key)) {
    throw new SettingsValidationError([{ key, reason: "unknown_key" }]);
  }
  const rows = await listConnectedSettingsVersions(key, HISTORY_LIMIT);
  return { versions: rows.map(versionView) };
}

/**
 * The bounds no single key can check on its own.
 *
 * `runtime-env.ts` refines that the MCP result limit stays at or below the
 * request limit, and a deployment whose environment breaks that rule refuses
 * to boot. Without the same check here an admin could store, through the API,
 * a pair the very same deployment would not start with, and find that out only
 * at the next deploy. The pair is judged as it would stand after the write
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
 */
export async function updateSettings(input: {
  patch: Readonly<Record<string, unknown>>;
  actor: string;
  reason: string;
}): Promise<SettingsPatchResponse> {
  const issues = validateSettingsPatch(input.patch);
  if (issues.length > 0) throw new SettingsValidationError(issues);

  const inForce = await loadSettingsResolution();
  const crossField = crossFieldIssues(input.patch, inForce.snapshot);
  if (crossField.length > 0) throw new SettingsValidationError(crossField);

  const versions = await writeManyConnectedSettings({
    patch: input.patch as Readonly<Record<string, SettingValue>>,
    actor: input.actor,
    reason: input.reason,
  });
  const [resolution, latest] = await Promise.all([
    loadSettingsResolution(),
    latestConnectedSettingsVersions(),
  ]);
  return {
    settings: entryViews(resolution, latest),
    versions: versions.map(versionView),
  };
}
