/**
 * The HTTP shapes of the settings surface.
 *
 * The read answers with one entry per registry key, resolved value included,
 * so the dashboard never has to repeat the resolution order. The patch takes a
 * partial map plus the reason it is being changed, because a settings change
 * without a recorded reason is exactly the change nobody can explain later.
 */
import { z } from "zod";
import type {
  SettingValue,
  SettingsGroup,
  SettingsInFlightRule,
} from "./settings-registry";

/** Where the value the worker is using actually came from. */
export type SettingsSource = "stored" | "environment" | "default";

/** One recorded change, as the history shows it. */
export interface SettingsVersionView {
  readonly id: number;
  readonly key: string;
  /** Null both for the first write of a key and for a stored null. */
  readonly previousValue: SettingValue;
  readonly newValue: SettingValue;
  /** Who made the change, as stored: a dashboard user id, or a named writer
   *  such as "migration" that is not a person. */
  readonly actor: string;
  /**
   * The person behind `actor`, as every other history in the dashboard names
   * one: their name, else their email. Equal to `actor` when no user has that
   * id (a named writer, or an account since deleted). Absent only from a worker
   * deployed before the field existed.
   */
  readonly actorLabel?: string;
  readonly reason: string;
  readonly createdAt: string;
}

/** What answers for a key once no row is stored for it: the variable the key
 *  names when the deployment sets it, otherwise the registry default. */
export interface SettingsFallbackView {
  readonly value: SettingValue;
  readonly source: Exclude<SettingsSource, "stored">;
}

/** One setting, resolved, with everything the form needs to render it. */
export interface SettingsEntryView {
  /**
   * A key of core's registry (a `SettingKey`), or of a setting an integration
   * declares (`settingDefinitions` in `@integrations/registry`), which no type
   * in this package can name.
   */
  readonly key: string;
  readonly value: SettingValue;
  readonly default: SettingValue;
  readonly source: SettingsSource;
  readonly group: SettingsGroup;
  readonly description: string;
  readonly appliesToRunsInFlight: SettingsInFlightRule;
  /**
   * Whether the running code still reads this key from the environment, so a
   * stored value records the decision and changes nothing until the worker is
   * redeployed. `appliesToRunsInFlight` cannot say that, which is why a surface
   * showing the key to somebody about to change it reads this as well. Absent
   * is the ordinary case: what the store holds is what is read.
   */
  readonly requiresRedeploy?: boolean;
  /** The newest recorded change to this key, or null when never written.
   *  Its `id` is the version a write of this key sends back as expected. */
  readonly lastVersion: SettingsVersionView | null;
  /**
   * What would answer if the stored row were removed, so a surface can say
   * what "Remove stored value" hands the key back to before anybody confirms
   * it. Absent only from a worker deployed before the field existed.
   */
  readonly fallback?: SettingsFallbackView;
}

/** GET /api/v1/settings */
export interface SettingsReadResponse {
  readonly settings: SettingsEntryView[];
}

/** GET /api/v1/settings?key=... */
export interface SettingsVersionsResponse {
  readonly versions: SettingsVersionView[];
}

/** A settings version token: the id of a key's newest history row, 0 for a key
 *  that had none when the caller read it. */
const settingsVersionToken = (message: string) =>
  z.number({ message }).int({ message }).min(0, { message });

const settingsReason = z
  .string({ message: "Invalid reason" })
  .trim()
  .min(1, { message: "Invalid reason" });

/**
 * PATCH /api/v1/settings.
 *
 * `settings` stays an open map here: which keys exist and what each one
 * accepts is the registry's question, answered by validateSettingsPatch, whose
 * refusal names every offending key instead of only the first.
 *
 * `expectedVersions` is the concurrency token, per key because versions are
 * per key: two people changing two different settings are not in each other's
 * way. For every key of the patch it names, the write is refused with 409 and
 * `SettingsVersionConflict` when somebody else has changed that key since, so a
 * second tab cannot silently undo the first. A key of the patch it does not
 * name is written unconditionally, and a request without it behaves exactly as
 * every client written before it: the last write wins.
 */
export const settingsPatchRequestSchema = z.object(
  {
    settings: z.record(z.string(), z.unknown(), {
      message: "Invalid settings",
    }),
    reason: settingsReason,
    expectedVersions: z
      .record(z.string(), settingsVersionToken("Invalid expectedVersions"), {
        message: "Invalid expectedVersions",
      })
      .optional(),
  },
  { message: "Invalid settings" },
);
export type SettingsPatchRequest = z.infer<typeof settingsPatchRequestSchema>;

/**
 * POST /api/v1/settings/reset: remove one stored row, so the variable the key
 * names or its registry default answers again. The HTTP twin of MCP
 * `settings.reset`, with the same optional concurrency token as the patch.
 */
export const settingsResetRequestSchema = z.object(
  {
    key: z.string({ message: "Invalid key" }).trim().min(1, { message: "Invalid key" }),
    reason: settingsReason,
    expectedVersion: settingsVersionToken("Invalid expectedVersion").optional(),
  },
  { message: "Invalid settings reset" },
);
export type SettingsResetRequest = z.infer<typeof settingsResetRequestSchema>;

/** The key as it stands after a reset. `removed` is false when nothing was
 *  stored, which is a success: the fallback was already answering. */
export interface SettingsResetResponse {
  readonly removed: boolean;
  readonly setting: SettingsEntryView;
}

/** One key a stale write was refused for, with what it holds now. */
export interface SettingsConflictView {
  readonly key: string;
  /** The version the caller sent. */
  readonly expectedVersion: number;
  /** The version the key is at now: the id of its newest history row. */
  readonly currentVersion: number;
  /** The key as it stands now, including who changed it last. */
  readonly setting: SettingsEntryView;
}

/**
 * The 409 body a stale settings write or reset is refused with. Nothing of the
 * request was written. Every refused key is named with its current state, so
 * a screen can show what the other person stored without a second read.
 */
export interface SettingsVersionConflict {
  readonly error: "settings_version_conflict";
  readonly conflicts: readonly SettingsConflictView[];
}

/** The resolved settings after the write, and the rows the write recorded. */
export interface SettingsPatchResponse {
  readonly settings: SettingsEntryView[];
  readonly versions: SettingsVersionView[];
}
