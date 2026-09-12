/**
 * Handing one setting back to the resolution order.
 *
 * The operation the settings surface has been missing: `updateSettings` can
 * store a value, and nothing could remove one, so a key stored by mistake (or
 * by a seed on a deployment whose environment already answered for it) stayed
 * stored forever and the environment variable beside it became decoration.
 *
 * Deliberately NOT "set it back to the default". The resolution order is the
 * stored row, then the deployment's environment, then the registry default, so
 * clearing the row hands the key to whichever of the other two answers, and on
 * a deployment that sets the variable that is the environment's value and not
 * the default. The outcome names the value that took over rather than leaving
 * the caller to work it out.
 */
import {
  findSettingDefinition,
  resolveSettingWithoutStoredRow,
  type SettingsEntryView,
} from "@shared/contracts";
import { deleteConnectedSetting } from "../../db/repositories/settings-reset.js";
import { settingsEnvironment } from "../../infra/settings-environment.js";
import { SettingsValidationError, readSettings } from "./store.js";

export interface SettingsResetOutcome {
  /** False when nothing was stored: the environment or the default was already
   *  answering, so no row was removed and no version was recorded. */
  removed: boolean;
  /** The key as it stands now, resolved, with the change that last touched it.
   *  Source says which of the two took over. */
  entry: SettingsEntryView;
}

export async function resetSetting(input: {
  key: string;
  actor: string;
  reason: string;
}): Promise<SettingsResetOutcome> {
  // Refused the way a patch of an unknown key is refused, and for the same
  // reason: a typo answered with "nothing was stored" reads as success.
  if (!findSettingDefinition(input.key)) {
    throw new SettingsValidationError([{ key: input.key, reason: "unknown_key" }]);
  }

  // What THIS key resolves to once its row is gone, from the resolution rule's
  // own second and third steps, so the version row records the value that
  // actually takes over. One key, not a read of every stored row: no setting's
  // resolved value depends on another's -- the cross-key bound the registry has
  // (the MCP result limit staying under the request limit) is a rule about what
  // may be STORED, checked on the write path, and it cannot change what a key
  // resolves to. If a future bound ever does, this is where it has to be read.
  const after = resolveSettingWithoutStoredRow(input.key, settingsEnvironment);
  // Whether a row existed is the delete's own answer, so nothing here asks
  // first: the statement returns the row it removed, or none.
  const removed = await deleteConnectedSetting({
    key: input.key,
    resolvedValue: after?.value ?? null,
    actor: input.actor,
    reason: input.reason,
  });
  return { removed, entry: await entryFor(input.key) };
}

/** Read back through the same view the settings page renders, rather than
 *  assembling a second one here: a statement cannot see its own writes, and two
 *  shapes for one setting is the drift this file must not create. */
async function entryFor(key: string): Promise<SettingsEntryView> {
  const entry = (await readSettings()).settings.find((candidate) => candidate.key === key);
  // The key was checked against the registry above and the registry is what
  // readSettings enumerates, so this cannot be missing; the throw keeps the
  // type honest rather than covering a case that can reach here.
  if (!entry) throw new SettingsValidationError([{ key, reason: "unknown_key" }]);
  return entry;
}
