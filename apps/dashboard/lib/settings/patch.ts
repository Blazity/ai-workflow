// apps/dashboard/lib/settings/patch.ts
//
// The form holds what the controls hold: a string for every typed control and a
// boolean for a switch. This module is the only place that turns those back
// into registry values and works out which of them actually changed, so the
// PATCH carries the keys the operator touched and nothing else.
import {
  findSettingDefinition,
  type SettingValue,
  type SettingsEntryView,
} from "@shared/contracts";

/** One form field's live value, keyed by registry key. */
export type SettingsDraft = Readonly<Record<string, string | boolean>>;

/**
 * A list setting is typed one name per line; commas are accepted too.
 *
 * Duplicates are dropped in the order they were first typed: the worker stores
 * the list verbatim, and a name repeated twice is a typo that would otherwise
 * sit in the store forever looking deliberate.
 */
function parseStringList(raw: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const entry = part.trim();
    if (entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    names.push(entry);
  }
  return names;
}

/** What a resolved value looks like inside its control. */
export function draftValueFor(entry: SettingsEntryView): string | boolean {
  const definition = findSettingDefinition(entry.key);
  if (definition?.type === "boolean") return entry.value === true;
  if (entry.value === null) return "";
  if (Array.isArray(entry.value)) return entry.value.join("\n");
  return String(entry.value);
}

/** The starting draft for a form: every rendered key at its resolved value. */
export function settingsDraftFrom(
  entries: readonly SettingsEntryView[],
): SettingsDraft {
  const draft: Record<string, string | boolean> = {};
  for (const entry of entries) draft[entry.key] = draftValueFor(entry);
  return draft;
}

/**
 * One control's value as the registry would store it.
 *
 * A number that was typed as something else is passed through as the string it
 * is rather than coerced to NaN: the worker refuses it with a message naming
 * the key, which is where the operator is told, and a silent coercion here
 * would write a value nobody typed.
 */
export function toSettingValue(
  key: string,
  raw: string | boolean,
): SettingValue {
  const definition = findSettingDefinition(key);
  if (typeof raw === "boolean") return raw;
  if (!definition) return raw;
  const trimmed = raw.trim();
  switch (definition.type) {
    case "boolean":
      return trimmed === "true";
    case "integer":
      if (trimmed === "") return null;
      return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
    case "string-list":
      return parseStringList(raw);
    case "string":
      // A key whose default is null has "unset" as a real state, so an emptied
      // field means null there and an empty string everywhere else. The value
      // is trimmed either way: a trailing space in a branch name or a board
      // column is never what anybody meant, and it is invisible on screen.
      return trimmed === "" && definition.default === null ? null : trimmed;
  }
}

/**
 * What is wrong with one field before the request is made.
 *
 * Only the refusals that would otherwise cost a round trip to hear: an emptied
 * field for a key that has no "unset" state, and anything in a number field
 * that is not a whole number. Everything else, the ranges above all, stays the
 * worker's answer so the two never drift.
 */
export function localSettingIssue(
  key: string,
  raw: string | boolean,
): string | undefined {
  const definition = findSettingDefinition(key);
  if (!definition || typeof raw === "boolean") return undefined;
  const trimmed = raw.trim();
  if (definition.type === "integer") {
    const wholeNumber =
      definition.minimum === undefined
        ? "Enter a whole number"
        : `Enter a whole number, at least ${definition.minimum}`;
    if (trimmed === "") return definition.default === null ? undefined : wholeNumber;
    if (!/^-?\d+$/.test(trimmed)) return wholeNumber;
    return undefined;
  }
  if (definition.type === "string" && trimmed === "" && definition.default !== null) {
    return "This setting cannot be left empty.";
  }
  return undefined;
}

/** Every field of a form that cannot be sent as typed, keyed the same way the
 *  worker's refusals are, so one map feeds the fields either way. */
export function localSettingIssues(
  entries: readonly SettingsEntryView[],
  draft: SettingsDraft,
): Record<string, string> {
  const issues: Record<string, string> = {};
  for (const entry of entries) {
    const raw = draft[entry.key];
    if (raw === undefined) continue;
    const issue = localSettingIssue(entry.key, raw);
    if (issue) issues[entry.key] = issue;
  }
  return issues;
}

function sameValue(a: SettingValue, b: SettingValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => entry === b[index]);
  }
  return a === b;
}

/**
 * The keys whose control no longer agrees with the resolved value.
 *
 * Only these travel in the PATCH. Sending a whole group would write a version
 * row for every key of it, which turns the history of the one setting somebody
 * changed into noise.
 */
export function buildSettingsPatch(
  entries: readonly SettingsEntryView[],
  draft: SettingsDraft,
): Record<string, SettingValue> {
  const patch: Record<string, SettingValue> = {};
  for (const entry of entries) {
    const raw = draft[entry.key];
    if (raw === undefined) continue;
    const next = toSettingValue(entry.key, raw);
    if (!sameValue(next, entry.value)) patch[entry.key] = next;
  }
  return patch;
}

/** Whether one field differs from what the worker resolved for it. */
export function isSettingChanged(
  entry: SettingsEntryView,
  draft: SettingsDraft,
): boolean {
  const raw = draft[entry.key];
  if (raw === undefined) return false;
  return !sameValue(toSettingValue(entry.key, raw), entry.value);
}
