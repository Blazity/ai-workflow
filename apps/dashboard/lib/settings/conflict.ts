// apps/dashboard/lib/settings/conflict.ts
//
// Two people, or one person in two tabs, changing the same settings. The worker
// refuses a stale write with 409 and names what each key holds now; this
// module is where the form decides what that means for what the person typed:
// it is kept, next to what won, until they choose.
import type {
  SettingsConflictView,
  SettingsEntryView,
  SettingsVersionConflict,
} from "@shared/contracts";

import { displaySettingValue, formatSettingActor, formatSettingTimestamp, settingLabel } from "./format";
import { draftValueFor, isSettingChanged, type SettingsDraft } from "./patch";

/** Whether a refusal body is the worker saying "somebody changed this first". */
export function isSettingsVersionConflict(body: unknown): body is SettingsVersionConflict {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { error?: unknown }).error === "settings_version_conflict" &&
    Array.isArray((body as { conflicts?: unknown }).conflicts)
  );
}

/**
 * A fresh server render merged into a form somebody may be typing in.
 *
 * A key the person has not touched takes the server's entry and value. A key
 * they have edited keeps both their value and the entry it was typed against,
 * version included, so storing it is refused with a conflict that shows what
 * changed, rather than quietly overwriting a change nobody here saw.
 */
export function keepEditsOver(
  saved: readonly SettingsEntryView[],
  draft: SettingsDraft,
  fresh: readonly SettingsEntryView[],
): { saved: SettingsEntryView[]; draft: SettingsDraft } {
  const loaded = new Map(saved.map((entry) => [entry.key, entry]));
  const nextSaved: SettingsEntryView[] = [];
  const nextDraft: Record<string, string | boolean> = {};
  for (const entry of fresh) {
    const before = loaded.get(entry.key);
    if (before && isSettingChanged(before, draft)) {
      nextSaved.push(before);
      nextDraft[entry.key] = draft[entry.key]!;
    } else {
      nextSaved.push(entry);
      nextDraft[entry.key] = draftValueFor(entry);
    }
  }
  return { saved: nextSaved, draft: nextDraft };
}

/** The form's loaded entries with the conflicting keys replaced by what won,
 *  so the next attempt carries the version the person has now been shown. */
export function withConflictsLoaded(
  saved: readonly SettingsEntryView[],
  conflicts: readonly SettingsConflictView[],
): SettingsEntryView[] {
  const won = new Map(conflicts.map((conflict) => [conflict.key, conflict.setting]));
  return saved.map((entry) => won.get(entry.key) ?? entry);
}

/** Drop the person's edits to the conflicting keys in favour of what won. */
export function takeTheirs(
  draft: SettingsDraft,
  conflicts: readonly SettingsConflictView[],
): SettingsDraft {
  const next: Record<string, string | boolean> = { ...draft };
  for (const conflict of conflicts) next[conflict.key] = draftValueFor(conflict.setting);
  return next;
}

/** One sentence per conflicting key: who changed it, when, and to what. */
export function conflictLines(conflicts: readonly SettingsConflictView[]): string[] {
  return conflicts.map((conflict) => {
    const last = conflict.setting.lastVersion;
    const who = last
      ? ` ${formatSettingActor(last.actor, last.actorLabel)} on ${formatSettingTimestamp(last.createdAt)}`
      : "";
    return `${settingLabel(conflict.key)} was changed${who} after this page loaded it: it is now ${displaySettingValue(conflict.setting.value)}.`;
  });
}
