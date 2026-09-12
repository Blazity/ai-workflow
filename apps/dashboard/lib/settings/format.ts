// apps/dashboard/lib/settings/format.ts
//
// Every string the Settings surface puts on screen that is derived rather than
// authored: the field label, the source badge, the applies-to note, the value
// as text, and the keys named by a refusal the worker sent back.
import {
  findSettingDefinition,
  type SettingValue,
  type SettingsInFlightRule,
  type SettingsSource,
} from "@shared/contracts";

/**
 * Words that are not sentence case.
 *
 * A registry key is SCREAMING_SNAKE, so a label built from it would otherwise
 * read "Mcp allow public dcr". Only the words a reader would spell differently
 * are listed; everything else is lowercased after the first word.
 */
const WORD_CASING: Record<string, string> = {
  AI: "AI",
  API: "API",
  DCR: "DCR",
  GITHUB: "GitHub",
  GITLAB: "GitLab",
  MB: "MB",
  MCP: "MCP",
  MS: "ms",
  PR: "PR",
  SSO: "SSO",
  URL: "URL",
  V2: "V2",
};

function casedWord(word: string, first: boolean): string {
  const known = WORD_CASING[word.toUpperCase()];
  if (known) return known;
  const lower = word.toLowerCase();
  return first ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
}

/**
 * A registry key as a field label.
 *
 * The key itself stays on screen next to it: an operator who is looking for the
 * variable they used to set in the environment has to be able to find it.
 */
export function settingLabel(key: string): string {
  const words = key
    .split(/[._\s]+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return key;
  return words
    .map((word, index) => casedWord(word, index === 0))
    .join(" ");
}

/**
 * The one thing every settings surface has to say out loud.
 *
 * Not "stored only" any more: the worker loads one settings snapshot per
 * request, per cron tick and per MCP call, so a saved value is a value the
 * worker reads. What an admin still cannot see from the form alone is WHEN it
 * reaches work already running, and that is per key: the rows say "immediately"
 * or "next run", and a run carries the snapshot it started with so a replay
 * sees what the first execution saw.
 */
export const SETTINGS_CADENCE_NOTICE =
  "Values saved here are stored and read: the worker loads a settings snapshot " +
  "per request, cron tick and MCP call. When a change reaches work already " +
  "running is per setting, and each row says which it is, immediately or on the " +
  "next run.";

/** The label above a field's resolved value. Deliberately not "in force": what
 *  a run already under way uses is the snapshot it started with, which the
 *  row's own cadence line states. */
export const RESOLVED_VALUE_LABEL = "Resolved value";

/** The badge on a field: where the value the store resolved came from. */
export function sourceLabel(source: SettingsSource): string {
  if (source === "stored") return "Stored";
  if (source === "environment") return "Environment";
  return "Default";
}

/** The sentence under the badge, so the badge does not have to be learned. */
export function sourceHint(source: SettingsSource): string {
  if (source === "stored") {
    return "Stored from this dashboard. A stored value shadows the environment variable until it is removed.";
  }
  if (source === "environment") return "Read from this deployment's environment.";
  return "Nothing is stored, so the built-in default is what the store resolves.";
}

/** When a change to this key reaches work already running. The worker loads one
 *  settings snapshot per request, cron tick and MCP call, so a stored value is
 *  read from the next entry onward either way; what differs per key is whether
 *  a run already under way picks it up. */
export function appliesToNote(rule: SettingsInFlightRule, requiresRedeploy = false): string {
  // A key the running code still reads from its own environment is the one case
  // the cadence above cannot describe, and it is not a cadence at all: the
  // store does not decide this key, so there is nothing here to apply. The
  // field is read-only and this says where the value is changed instead.
  if (requiresRedeploy) {
    return "Read from the deployment environment; change the variable there and redeploy";
  }
  return rule === "immediate"
    ? "Applies immediately"
    : "Applies to the next run; a run already under way keeps the settings it started with";
}

/**
 * A recorded change's timestamp, in the reader's own zone.
 *
 * Only ever rendered inside the history drawer, which is fetched in the browser
 * after mount, so the server and the client can never disagree on the text the
 * way they would on a server rendered date.
 */
export function formatSettingTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** Who made a recorded change. The store keeps the user id, not a display name,
 *  so the label says which one it is rather than passing an opaque string off
 *  as a person's name. */
export function formatSettingActor(actor: string): string {
  if (actor === "migration") return "by the seed migration";
  // Not a person either: the worker writing a value it found in its own
  // environment so the variable can be retired. "by user environment import"
  // would read as somebody's account name.
  if (actor === "environment import") return "by the environment import";
  return `by user ${actor}`;
}

/**
 * A resolved value as text.
 *
 * "not set" is the honest answer for a key whose environment variable is unset
 * and whose registry default is null: it has no value at all, which is not the
 * same as an empty string or a zero.
 */
export function displaySettingValue(value: SettingValue): string {
  if (value === null) return "not set";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length === 0 ? "empty" : value.join(", ");
  if (value === "") return "empty";
  return String(value);
}

const ISSUE_PATTERN =
  /([A-Za-z0-9_.]+)\s*\((unknown_key|wrong_type|not_allowed_value|below_minimum|null_not_allowed|above_request_limit)\)/g;

function issueSentence(key: string, reason: string): string {
  const definition = findSettingDefinition(key);
  switch (reason) {
    case "unknown_key":
      return "This deployment's worker does not know this setting.";
    case "wrong_type":
      return definition
        ? `This setting takes ${definition.type === "string-list" ? "a list of names" : `a ${definition.type}`}.`
        : "The value has the wrong type.";
    case "not_allowed_value":
      return definition?.enumValues
        ? `Allowed values: ${definition.enumValues.join(", ")}.`
        : "That value is not allowed.";
    case "below_minimum":
      return definition?.minimum === undefined
        ? "The value is below the smallest one accepted."
        : `Must be at least ${definition.minimum}.`;
    case "null_not_allowed":
      return "This setting cannot be left empty.";
    default:
      return "The MCP result limit must stay at or below the request limit.";
  }
}

/**
 * The keys a 400 named, mapped to what to show next to each field.
 *
 * The worker answers a refused patch with `Invalid settings: KEY (reason), ...`
 * and names every offending key rather than the first, which is the whole point
 * of showing the message per field instead of once per group. A message that
 * names no key at all (a bad reason, a group this route refuses) returns an
 * empty map, and the caller keeps showing it above the form.
 */
export function settingIssuesFromMessage(
  message: string,
): Record<string, string> {
  const issues: Record<string, string> = {};
  for (const match of message.matchAll(ISSUE_PATTERN)) {
    const [, key, reason] = match;
    if (!key || !reason) continue;
    issues[key] = issueSentence(key, reason);
  }
  return issues;
}
