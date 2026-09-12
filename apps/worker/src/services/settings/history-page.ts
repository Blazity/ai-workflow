/**
 * One setting's recorded changes, a page at a time.
 *
 * `readSettingsHistory` in `store.ts` answers the newest fifty, which is what
 * the Settings page renders and all a person needs. An agent reading a history
 * has no scrollbar to tell it there is more, so this adds the one fact a
 * protocol has to carry instead of show.
 */
import { findSettingDefinition } from "@shared/contracts";
import type { SettingsVersionView } from "@shared/contracts";
import { listConnectedSettingsVersionPageRows } from "../../db/repositories/settings-history.js";
import { SettingsValidationError, versionView } from "./store.js";

export interface SettingsHistoryPage {
  versions: SettingsVersionView[];
  /** Whether changes older than the last one on this page exist. */
  hasMore: boolean;
}

/**
 * One page of a key's history, newest first.
 *
 * The key is checked against the registry first, and for the reason
 * `readSettingsHistory` checks it: an empty page for a key that does not exist
 * reads as "nothing was ever changed here", which is the wrong thing to learn
 * from a typo.
 *
 * `before` takes a version row id and means "older than this".
 */
export async function readSettingsHistoryPage(input: {
  key: string;
  limit: number;
  before?: number;
}): Promise<SettingsHistoryPage> {
  if (!findSettingDefinition(input.key)) {
    throw new SettingsValidationError([{ key: input.key, reason: "unknown_key" }]);
  }
  // One row past the page, read to answer "is there more" and then dropped.
  const rows = await listConnectedSettingsVersionPageRows({
    key: input.key,
    limit: input.limit + 1,
    before: input.before,
  });
  return {
    versions: rows.slice(0, input.limit).map(versionView),
    hasMore: rows.length > input.limit,
  };
}
