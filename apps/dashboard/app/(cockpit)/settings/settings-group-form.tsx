"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { settingDefinition } from "@integrations/registry";
import type { SettingsConflictView, SettingsEntryView } from "@shared/contracts";

import { Button, CkChip, Input, type ChipTone } from "@/components/ui";
import { apiClient } from "@/lib/api/client";
import {
  conflictLines,
  isSettingsVersionConflict,
  keepEditsOver,
  takeTheirs,
  withConflictsLoaded,
} from "@/lib/settings/conflict";
import {
  RESOLVED_VALUE_LABEL,
  appliesToNote,
  displaySettingValue,
  settingIssuesFromMessage,
  settingLabel,
  sourceHint,
  sourceLabel,
} from "@/lib/settings/format";
import { selectGroupKeys, storedRowCount, type SettingsGroupView } from "@/lib/settings/groups";
import {
  buildSettingsPatch,
  draftValueFor,
  expectedVersionsFor,
  isSettingChanged,
  localSettingIssues,
  settingsDraftFrom,
  type SettingsDraft,
} from "@/lib/settings/patch";
import { useUnsavedWork } from "@/lib/settings/use-unsaved-work";

import { RemoveStoredValue } from "./remove-stored-value";
import { SettingControl } from "./setting-control";
import { SettingHistory } from "./setting-history";

const SOURCE_TONES: Record<SettingsEntryView["source"], ChipTone> = {
  stored: "mariner",
  environment: "neutral",
  default: "blocked",
};

type Message = { tone: "ok" | "error"; text: string };

/** What the registry falls back to, said once per field so the placeholder is
 *  free to say "required" instead of showing a value nobody typed. */
function defaultNote(entry: SettingsEntryView): string {
  const definition = settingDefinition(entry.key);
  if (definition?.default === null) {
    return "No default: this setting is unset until a value is given.";
  }
  return `Default: ${displaySettingValue(entry.default)}.`;
}

/** Whether this field offers removing its stored value, says who may, or
 *  says nothing (nothing stored, or a reader who can change nothing here). */
type Removal =
  | { kind: "none" }
  | { kind: "owner_only" }
  | {
      kind: "allowed";
      onRemoved: (setting: SettingsEntryView, removed: boolean) => void;
      onConflict: (conflicts: readonly SettingsConflictView[]) => void;
    };

/** Somebody changed these keys first, and whether it was a store or a removal
 *  of this form's that the worker refused: only a store has edits to keep. */
type Conflict = {
  refused: "store" | "remove";
  conflicts: readonly SettingsConflictView[];
};

function SettingField({
  entry,
  value,
  disabled,
  changed,
  issue,
  historyOpen,
  removal,
  onToggleHistory,
  onChange,
}: {
  entry: SettingsEntryView;
  value: string | boolean;
  disabled: boolean;
  changed: boolean;
  issue: string | undefined;
  historyOpen: boolean;
  removal: Removal;
  onToggleHistory: () => void;
  onChange: (next: string | boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-body text-[12px] font-semibold text-neutral-800">
          {settingLabel(entry.key)}
        </span>
        <span className="font-mono text-[10px] text-neutral-500">{entry.key}</span>
        <CkChip tone={SOURCE_TONES[entry.source]}>{sourceLabel(entry.source)}</CkChip>
        {changed && (
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-burnt-orange">
            Unsaved
          </span>
        )}
      </div>
      <p className="m-0 font-body text-[11px] text-neutral-600">
        {entry.description} {defaultNote(entry)}
      </p>
      <SettingControl
        entry={entry}
        value={value}
        disabled={disabled}
        invalid={issue !== undefined}
        onChange={onChange}
      />
      <p className="m-0 font-body text-[11px] text-neutral-500">
        {RESOLVED_VALUE_LABEL}:{" "}
        <span className="font-mono">{displaySettingValue(entry.value)}</span>.{" "}
        {sourceHint(entry.source)} {appliesToNote(entry.appliesToRunsInFlight, entry.requiresRedeploy)}.
      </p>
      {issue && <p className="m-0 font-body text-[11px] text-fail-fg">{issue}</p>}
      {removal.kind === "allowed" && (
        <div>
          <RemoveStoredValue
            entry={entry}
            discardsEdit={changed}
            disabled={disabled}
            onRemoved={removal.onRemoved}
            onConflict={removal.onConflict}
          />
        </div>
      )}
      {removal.kind === "owner_only" && (
        <p className="m-0 font-body text-[11px] text-neutral-500">
          Only an owner can remove a stored value.
        </p>
      )}
      <div>
        <Button
          variant="text"
          onClick={onToggleHistory}
          aria-expanded={historyOpen}
          className="appearance-none border-none bg-transparent p-0 cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-mariner"
        >
          {historyOpen ? "Hide history" : "History"}
          {entry.lastVersion ? " (changed here before)" : " (never changed here)"}
        </Button>
        {historyOpen && <SettingHistory settingKey={entry.key} />}
      </div>
    </div>
  );
}

/**
 * One registry group as a form, saved in one PATCH.
 *
 * The Memory panel mounts the same component with a key filter, so a switch
 * behaves identically wherever it is shown: the same controls, the same reason,
 * the same refusals. Only the keys the operator actually changed travel in the
 * patch, because a version row per untouched key would bury the one change
 * somebody has to be able to find.
 */
export function SettingsGroupForm({
  group,
  canEdit,
  canReset,
  keys,
  heading,
  description,
  note,
}: {
  group: SettingsGroupView;
  /** The role rule: false renders every control read only with the notice. */
  canEdit: boolean;
  /** canResetSettings(role): true offers "Remove stored value", false says
   *  who may. Left out, the form offers neither, so a panel that mounts it
   *  without deciding keeps what it had. */
  canReset?: boolean;
  /** Renders only these keys. The area panels pass a module level list. */
  keys?: readonly string[];
  heading?: string;
  description?: string;
  note?: string;
}) {
  const router = useRouter();
  const formId = useId();
  const title = heading ?? group.label;
  const visible = selectGroupKeys(group, keys);
  const visibleKey = JSON.stringify(visible);

  const [appliedKey, setAppliedKey] = useState(visibleKey);
  const [saved, setSaved] = useState<readonly SettingsEntryView[]>(visible);
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraftFrom(visible));
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<Message | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [saving, setSaving] = useState(false);
  const [openHistory, setOpenHistory] = useState<string | null>(null);

  // A fresh server render supersedes the local copy for every field nobody
  // here is editing. A field with an unsaved edit keeps it, and keeps the
  // version it was typed against: Live refreshes this page, and re-seeding the
  // whole form threw away an edit the moment another tab stored anything in
  // the same group.
  useEffect(() => {
    if (visibleKey === appliedKey) return;
    const next = keepEditsOver(saved, draft, visible);
    setSaved(next.saved);
    setDraft(next.draft);
    setAppliedKey(visibleKey);
  }, [visibleKey, appliedKey, visible, saved, draft]);

  const patch = buildSettingsPatch(saved, draft);
  const changedCount = Object.keys(patch).length;
  const dirty = changedCount > 0;
  // The shell asks the registry before every router.push, and the browser
  // asks this form's listener before a tab close. Back and forward are left to
  // the Repository scripts sentinel: one sentinel per dirty form would stack up
  // to ten of them on the Settings page, and pushing history entries nobody
  // asked for is worse than the gap it would close.
  useUnsavedWork(formId, dirty);

  function discard() {
    setDraft(settingsDraftFrom(saved));
    setIssues({});
    setMessage(null);
    setConflict(null);
  }

  /**
   * Somebody changed some of these keys after this form loaded them, and the
   * worker stored nothing. What was typed stays; the form now shows, and
   * carries the version of, what won, so storing again is a decision made
   * with both values on screen.
   */
  function showConflicts(refused: Conflict["refused"], found: readonly SettingsConflictView[]) {
    // A field nobody here edited shows what won; an edited one keeps the edit.
    const loaded = new Map(saved.map((entry) => [entry.key, entry]));
    setDraft((current) => {
      const next: Record<string, string | boolean> = { ...current };
      for (const conflictView of found) {
        const before = loaded.get(conflictView.key);
        if (!before || !isSettingChanged(before, current)) {
          next[conflictView.key] = draftValueFor(conflictView.setting);
        }
      }
      return next;
    });
    setSaved((current) => withConflictsLoaded(current, found));
    setConflict({ refused, conflicts: found });
    setMessage(null);
    router.refresh();
  }

  function takeTheirValues() {
    if (!conflict) return;
    setDraft((current) => takeTheirs(current, conflict.conflicts));
    setConflict(null);
  }

  function removedStoredValue(setting: SettingsEntryView, removed: boolean) {
    setSaved((current) =>
      current.map((entry) => (entry.key === setting.key ? setting : entry)),
    );
    setDraft((current) => ({ ...current, [setting.key]: draftValueFor(setting) }));
    setIssues((current) => {
      const next = { ...current };
      delete next[setting.key];
      return next;
    });
    setConflict(null);
    const resolves = `${displaySettingValue(setting.value)} (${sourceLabel(setting.source).toLowerCase()})`;
    setMessage({
      tone: "ok",
      text: removed
        ? `Removed the stored value of ${settingLabel(setting.key)}. It now resolves to ${resolves}.`
        : `Nothing was stored for ${settingLabel(setting.key)} any more. It resolves to ${resolves}.`,
    });
    router.refresh();
  }

  async function save() {
    if (!dirty || saving || reason.trim() === "") return;
    const local = localSettingIssues(saved, draft);
    if (Object.keys(local).length > 0) {
      setIssues(local);
      setMessage({ tone: "error", text: "Some fields cannot be sent as typed." });
      return;
    }
    setSaving(true);
    setMessage(null);
    setConflict(null);
    try {
      const result = await apiClient.settings.update({
        settings: patch,
        reason: reason.trim(),
        expectedVersions: expectedVersionsFor(saved, patch),
      });
      if (!result.ok && result.status === 409 && isSettingsVersionConflict(result.error)) {
        showConflicts("store", result.error.conflicts);
        return;
      }
      if (!result.ok) {
        const named = settingIssuesFromMessage(result.errorMessage);
        setIssues(named);
        const unplaced = Object.keys(named).filter(
          (key) => !saved.some((entry) => entry.key === key),
        );
        setMessage({
          tone: "error",
          text:
            result.status === 403
              ? "Your role can read settings but not change them."
              : Object.keys(named).length === 0 || unplaced.length > 0
                ? result.errorMessage
                : "The worker refused some of these values. See the fields below.",
        });
        return;
      }
      const byKey = new Map(result.data.settings.map((entry) => [entry.key, entry]));
      const next = saved.map((entry) => byKey.get(entry.key) ?? entry);
      setSaved(next);
      setDraft(settingsDraftFrom(next));
      setIssues({});
      setReason("");
      setMessage({
        tone: "ok",
        text: `Stored ${changedCount} ${changedCount === 1 ? "setting" : "settings"}.`,
      });
      // The listing on the server is what every other surface reads; refreshing
      // is what makes the rest of the cockpit agree with this form.
      router.refresh();
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Unable to save these settings",
      });
    } finally {
      setSaving(false);
    }
  }

  const stored = storedRowCount(saved);
  const reasonMissing = reason.trim() === "";

  return (
    <section className="rounded-[4px] border border-neutral-200 bg-panel">
      <header className="px-4 pt-3 pb-[10px] border-b border-neutral-200">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="m-0 font-display text-[15px] font-medium text-coal">{title}</h3>
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
            {stored} of {saved.length} {saved.length === 1 ? "setting" : "settings"} here stored
          </span>
        </div>
        <p className="m-0 mt-1 font-body text-[11px] text-neutral-600">
          {description ?? group.description}
        </p>
        {note && (
          <p className="m-0 mt-1 font-body text-[11px] text-neutral-600">{note}</p>
        )}
      </header>

      <div className="px-4 py-3 flex flex-col gap-5">
        {saved.length === 0 ? (
          <p className="m-0 font-body text-[12px] text-neutral-500">
            This deployment&apos;s worker reports no settings in this group.
          </p>
        ) : (
          saved.map((entry) => (
            <SettingField
              key={entry.key}
              entry={entry}
              value={draft[entry.key] ?? ""}
              // Read-only whoever is looking: the worker reads this key
              // from its own environment, so a value stored from here would be
              // recorded and then ignored by the resolution.
              disabled={!canEdit || saving || entry.requiresRedeploy === true}
              changed={isSettingChanged(entry, draft)}
              issue={issues[entry.key]}
              historyOpen={openHistory === entry.key}
              removal={
                !canEdit || entry.source !== "stored" || canReset === undefined
                  ? { kind: "none" }
                  : canReset
                    ? {
                        kind: "allowed",
                        onRemoved: removedStoredValue,
                        onConflict: (found) => showConflicts("remove", found),
                      }
                    : { kind: "owner_only" }
              }
              onToggleHistory={() =>
                setOpenHistory((current) => (current === entry.key ? null : entry.key))
              }
              onChange={(next) =>
                setDraft((current) => ({ ...current, [entry.key]: next }))
              }
            />
          ))
        )}
      </div>

      {conflict && conflict.conflicts.length > 0 && (
        <div
          role="alert"
          className="mx-4 mb-3 mt-0 flex flex-col gap-2 rounded-[3px] border border-[#F0B8AE] bg-fail-bg px-3 py-2 font-body text-[11px] text-fail-fg"
        >
          {conflictLines(conflict.conflicts).map((line) => (
            <p key={line} className="m-0">
              {line}
            </p>
          ))}
          {conflict.refused === "remove" ? (
            <p className="m-0">
              Nothing was removed. The field now shows the new value; remove it
              again if you still mean to.
            </p>
          ) : (
            <p className="m-0">
              Nothing was stored. Your edits are kept below: store them over the
              new value, or take theirs.
            </p>
          )}
          {conflict.refused === "store" && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={save}
                disabled={!dirty || saving || reasonMissing}
                loading={saving}
              >
                Store mine anyway
              </Button>
              <Button variant="secondary" size="sm" onClick={takeTheirValues} disabled={saving}>
                Use theirs
              </Button>
            </div>
          )}
        </div>
      )}

      {message && (
        <p
          className={`mx-4 mb-3 mt-0 rounded-[3px] border px-3 py-2 font-body text-[11px] ${
            message.tone === "ok"
              ? "border-[#B8DDAA] bg-success-bg text-success-fg"
              : "border-[#F0B8AE] bg-fail-bg text-fail-fg"
          }`}
        >
          {message.text}
        </p>
      )}

      {!canEdit && saved.length > 0 && (
        <footer className="px-4 py-[10px] border-t border-neutral-200 font-body text-[11px] text-neutral-600">
          Read-only: ask an owner or admin to change these settings.
        </footer>
      )}

      {canEdit && saved.length > 0 && (
        <footer className="px-4 py-3 border-t border-neutral-200 flex flex-col gap-[6px]">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="text"
              value={reason}
              required
              aria-required="true"
              aria-label={`Reason for changing ${title}`}
              placeholder="Why is this changing? (required)"
              disabled={saving}
              onChange={(event) => setReason(event.target.value)}
              className="flex-1 min-w-[180px]"
            />
            <Button
              variant="secondary"
              onClick={discard}
              disabled={!dirty || saving}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              onClick={save}
              disabled={!dirty || saving || reasonMissing}
              loading={saving}
            >
              {saving
                ? "Saving"
                : !dirty
                  ? "Nothing to save"
                  : `Store ${changedCount} ${changedCount === 1 ? "change" : "changes"}`}
            </Button>
          </div>
          {dirty && reasonMissing && (
            <p className="m-0 font-body text-[11px] text-neutral-600">
              A reason is required: a behaviour change nobody can explain later is
              what the recorded history exists to prevent.
            </p>
          )}
        </footer>
      )}
    </section>
  );
}
