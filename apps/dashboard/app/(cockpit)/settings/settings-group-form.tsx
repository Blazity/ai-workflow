"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { findSettingDefinition } from "@shared/contracts";
import type { SettingsEntryView } from "@shared/contracts";

import { CkChip, type ChipTone } from "@/components/ui";
import { apiClient } from "@/lib/api/client";
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
  isSettingChanged,
  localSettingIssues,
  settingsDraftFrom,
  type SettingsDraft,
} from "@/lib/settings/patch";
import { trackUnsavedSettings } from "@/lib/settings/unsaved";

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
  const definition = findSettingDefinition(entry.key);
  if (definition?.default === null) {
    return "No default: this setting is unset until a value is given.";
  }
  return `Default: ${displaySettingValue(entry.default)}.`;
}

function SettingField({
  entry,
  value,
  disabled,
  changed,
  issue,
  historyOpen,
  onToggleHistory,
  onChange,
}: {
  entry: SettingsEntryView;
  value: string | boolean;
  disabled: boolean;
  changed: boolean;
  issue: string | undefined;
  historyOpen: boolean;
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
        {sourceHint(entry.source)} {appliesToNote(entry.appliesToRunsInFlight)}.
      </p>
      {issue && <p className="m-0 font-body text-[11px] text-fail-fg">{issue}</p>}
      <div>
        <button
          type="button"
          onClick={onToggleHistory}
          aria-expanded={historyOpen}
          className="appearance-none border-none bg-transparent p-0 cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-mariner"
        >
          {historyOpen ? "Hide history" : "History"}
          {entry.lastVersion ? " (changed here before)" : " (never changed here)"}
        </button>
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
  keys,
  heading,
  description,
  note,
}: {
  group: SettingsGroupView;
  /** The role rule: false renders every control read only with the notice. */
  canEdit: boolean;
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
  const [saving, setSaving] = useState(false);
  const [openHistory, setOpenHistory] = useState<string | null>(null);

  // A fresh server render supersedes the local copy: the values the worker
  // resolved always win over what this form was holding.
  useEffect(() => {
    if (visibleKey === appliedKey) return;
    setSaved(visible);
    setDraft(settingsDraftFrom(visible));
    setIssues({});
    setAppliedKey(visibleKey);
  }, [visibleKey, appliedKey, visible]);

  const patch = buildSettingsPatch(saved, draft);
  const changedCount = Object.keys(patch).length;
  const dirty = changedCount > 0;

  // The shell asks the module below before every router.push, and the browser
  // asks the listener below before a tab close. Back and forward are left to
  // the Repository scripts sentinel: one sentinel per dirty form would stack up
  // to ten of them on the Settings page, and pushing history entries nobody
  // asked for is worse than the gap it would close.
  useEffect(() => trackUnsavedSettings(formId, dirty), [formId, dirty]);

  useEffect(() => {
    if (!dirty || typeof window === "undefined") return;
    const w = window;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy prompt trigger, still required by Chrome and Edge before 119.
      event.returnValue = true;
    };
    w.addEventListener("beforeunload", onBeforeUnload);
    return () => w.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function discard() {
    setDraft(settingsDraftFrom(saved));
    setIssues({});
    setMessage(null);
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
    try {
      const result = await apiClient.settings.update({
        settings: patch,
        reason: reason.trim(),
      });
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
            {stored} of {saved.length} stored
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
              disabled={!canEdit || saving}
              changed={isSettingChanged(entry, draft)}
              issue={issues[entry.key]}
              historyOpen={openHistory === entry.key}
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
            <input
              type="text"
              value={reason}
              required
              aria-required="true"
              aria-label={`Reason for changing ${title}`}
              placeholder="Why is this changing? (required)"
              disabled={saving}
              onChange={(event) => setReason(event.target.value)}
              className="flex-1 min-w-[180px] rounded-[3px] border border-neutral-200 bg-white px-2 py-[6px] font-body text-[12px] text-neutral-800"
            />
            <button
              type="button"
              onClick={discard}
              disabled={!dirty || saving}
              className="appearance-none rounded-[3px] border border-neutral-200 bg-panel px-3 py-[6px] font-body text-[12px] text-neutral-700 cursor-pointer disabled:opacity-40 disabled:cursor-default"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving || reasonMissing}
              className="appearance-none rounded-[3px] border-none bg-mariner px-3 py-[6px] font-body text-[12px] font-medium text-white cursor-pointer disabled:opacity-40 disabled:cursor-default"
            >
              {saving
                ? "Saving"
                : !dirty
                  ? "Nothing to save"
                  : `Store ${changedCount} ${changedCount === 1 ? "change" : "changes"}`}
            </button>
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
