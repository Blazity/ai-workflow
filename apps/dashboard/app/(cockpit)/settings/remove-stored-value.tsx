"use client";

import { useState } from "react";
import { settingDefinition } from "@integrations/registry";
import type { SettingsConflictView, SettingsEntryView } from "@shared/contracts";

import { Button, Field, Input, Modal } from "@/components/ui";
import { apiClient } from "@/lib/api/client";
import { isSettingsVersionConflict } from "@/lib/settings/conflict";
import {
  appliesToNote,
  displaySettingValue,
  fallbackSentence,
  settingLabel,
} from "@/lib/settings/format";

/**
 * "Remove stored value": hand one key back to the environment variable it
 * names, or to its built-in default.
 *
 * The confirmation says what takes over and from where before anybody
 * confirms, because the value is not one the person typed. It carries the
 * version the page loaded, so a value somebody else stored in the meantime is
 * not thrown away unseen: the worker refuses with a conflict and the form
 * shows what is stored now.
 */
export function RemoveStoredValue({
  entry,
  discardsEdit,
  disabled,
  onRemoved,
  onConflict,
}: {
  entry: SettingsEntryView;
  /** The field holds an unsaved edit that removing the value throws away. */
  discardsEdit: boolean;
  disabled: boolean;
  /** `removed` is false when nothing was stored any more by the time the
   *  request arrived: the fallback was already answering. */
  onRemoved: (setting: SettingsEntryView, removed: boolean) => void;
  onConflict: (conflicts: readonly SettingsConflictView[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = settingLabel(entry.key);

  function close() {
    if (busy) return;
    setOpen(false);
    setReason("");
    setError(null);
  }

  async function confirm() {
    if (busy || reason.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.settings.reset({
        key: entry.key,
        reason: reason.trim(),
        expectedVersion: entry.lastVersion?.id ?? 0,
      });
      if (result.ok) {
        setOpen(false);
        setReason("");
        onRemoved(result.data.setting, result.data.removed);
        return;
      }
      if (result.status === 409 && isSettingsVersionConflict(result.error)) {
        setOpen(false);
        setReason("");
        onConflict(result.error.conflicts);
        return;
      }
      setError(result.errorMessage);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : "Unable to remove the stored value");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="text"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="font-mono text-[10px] uppercase tracking-[0.06em] text-fail-fg"
      >
        Remove stored value
      </Button>
      {open && (
        <Modal title={`Remove the stored value of ${label}?`} onClose={close} size="sm">
          <div className="flex flex-col gap-2 font-body text-[13px] text-neutral-800">
            <p className="m-0">
              {label} (<span className="font-mono text-[12px]">{entry.key}</span>) is
              stored as <span className="font-mono text-[12px]">{displaySettingValue(entry.value)}</span>.
            </p>
            <p className="m-0">
              {fallbackSentence(entry.fallback, settingDefinition(entry.key)?.environmentVariable)}{" "}
              {appliesToNote(entry.appliesToRunsInFlight, entry.requiresRedeploy)}.
            </p>
            {discardsEdit && (
              <p className="m-0">Your unsaved edit to this field is discarded.</p>
            )}
            <Field label="Reason" required>
              <Input
                type="text"
                value={reason}
                placeholder="Why is this going back? (required)"
                disabled={busy}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            {error && (
              <p role="alert" className="m-0 text-[12px] text-fail-fg">
                {error}
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <Button
                variant="danger"
                loading={busy}
                disabled={reason.trim() === ""}
                onClick={confirm}
              >
                Remove stored value
              </Button>
              <Button variant="secondary" disabled={busy} onClick={close}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
