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
  SettingKey,
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
  readonly actor: string;
  readonly reason: string;
  readonly createdAt: string;
}

/** One setting, resolved, with everything the form needs to render it. */
export interface SettingsEntryView {
  readonly key: SettingKey;
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
  /** The newest recorded change to this key, or null when never written. */
  readonly lastVersion: SettingsVersionView | null;
}

/** GET /api/v1/settings */
export interface SettingsReadResponse {
  readonly settings: SettingsEntryView[];
  /**
   * The migrated environment variables this deployment still sets, by name.
   *
   * Alongside the entries rather than inside them, because it is a fact about
   * the deployment and not about any one setting: every value behind these
   * names is stored by now, and the next release refuses to boot with any of
   * them still set. Names only, never values.
   */
  readonly migratedVariablesSet: readonly string[];
  /**
   * Those of them no stored row answers for yet, by name.
   *
   * The safety half of the pair: removing a variable on this list would lose
   * the value the deployment is running on, because nothing else holds it. It
   * empties as the import stores them, and a name that stays on it is a write
   * that did not happen, which is the state the banner has to show rather than
   * hide. Names only, never values.
   */
  readonly migratedVariablesUnstored: readonly string[];
}

/** GET /api/v1/settings?key=... */
export interface SettingsVersionsResponse {
  readonly versions: SettingsVersionView[];
}

/**
 * PATCH /api/v1/settings.
 *
 * `settings` stays an open map here: which keys exist and what each one
 * accepts is the registry's question, answered by validateSettingsPatch, whose
 * refusal names every offending key instead of only the first.
 */
export const settingsPatchRequestSchema = z.object(
  {
    settings: z.record(z.string(), z.unknown(), {
      required_error: "Invalid settings",
      invalid_type_error: "Invalid settings",
    }),
    reason: z
      .string({ required_error: "Invalid reason", invalid_type_error: "Invalid reason" })
      .trim()
      .min(1, { message: "Invalid reason" }),
  },
  { required_error: "Invalid settings", invalid_type_error: "Invalid settings" },
);
export type SettingsPatchRequest = z.infer<typeof settingsPatchRequestSchema>;

/** The resolved settings after the write, and the rows the write recorded. */
export interface SettingsPatchResponse {
  readonly settings: SettingsEntryView[];
  readonly versions: SettingsVersionView[];
}
