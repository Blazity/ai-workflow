/**
 * The Settings page, as tools.
 *
 * Four tools for the four things the page does: read every switch, read one
 * with its history, store one, and clear one so the environment or the registry
 * default answers for it again.
 *
 * The registry is the authority on what a key accepts and the store is the
 * authority on what a write records, exactly as on the HTTP side: nothing here
 * validates a value, decides a resolution order or invents a version row.
 * What this file adds is the two things a page carries in its layout and a
 * protocol has to carry in its payload -- whether a key can be written through
 * an API at all, and who may -- so an agent is told before it tries rather than
 * after it is refused.
 *
 * No credential is on this surface by construction. The registry deliberately
 * holds no key, token, database URL or auth URL (those stay in the environment),
 * so there is no secret-class entry to mask, and any configured secret value is
 * scrubbed from every reply by the same sanitizer every other tool is sealed
 * with. The day a secret-class key is added to the registry, it has to be
 * masked here before it can be listed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  findSettingDefinition,
  type SettingsEntryView,
  type SettingsInFlightRule,
  type SettingsVersionView,
} from "@shared/contracts";
import {
  SETTINGS_EDIT_ROLE,
  SettingsValidationError,
  isSettingEditableThroughMcp,
  readSettings,
  readSettingsHistoryPage,
  resetSetting,
  settingEditRole,
  settingMcpEditRefusal,
  updateSettings,
} from "../../services/settings/index.js";
import { McpPublicError, type McpToolDependencies } from "../contracts.js";
import { executeMcpMutation, executeMcpRead } from "../execute-tool.js";
import { hashCanonicalJson } from "../sanitize-result.js";
import {
  HISTORY_PAGE_DEFAULT,
  mcpEnvelopeResult,
  registerCatalogTool,
} from "../tool-catalog.js";

/**
 * A registry refusal, as an agent reads it.
 *
 * `SettingsValidationError` already names every offending key and why, which is
 * the whole message the dashboard shows, so it is forwarded rather than
 * summarized. Every one of them is raised before `writeManySettings` runs, so
 * the key is provably unspent and a corrected call may reuse it.
 */
function throwPublicSettingsError(error: unknown): never {
  if (error instanceof SettingsValidationError) {
    throw new McpPublicError(
      "VALIDATION_FAILED",
      error.message,
      false,
      undefined,
      true,
    );
  }
  throw error;
}

/** One setting as this surface publishes it: the store's own view, plus the two
 *  facts the dashboard expresses as a disabled field and a hidden button. */
type SettingView = Omit<SettingsEntryView, "appliesToRunsInFlight"> & {
  /** Whether settings.set may store this key from THIS surface. */
  editable: boolean;
  /** Who may store it, or null when no write on this surface may. */
  role: typeof SETTINGS_EDIT_ROLE | null;
  /**
   * When a change reaches a run, widened by one answer the registry's own rule
   * cannot give: a key the running code still reads from the environment does
   * not reach the next run either, it reaches the next DEPLOYMENT.
   */
  appliesToRunsInFlight: SettingsInFlightRule | "after redeploy";
  /** Whether the value in the store is read at all before a redeploy. */
  requiresRedeploy: boolean;
};

function viewOf(entry: SettingsEntryView): SettingView {
  const editable = isSettingEditableThroughMcp(entry.key);
  const requiresRedeploy = findSettingDefinition(entry.key)?.requiresRedeploy === true;
  return {
    ...entry,
    editable,
    // Null whenever THIS surface refuses the key, whichever of the two reasons
    // applies: an agent asking "who may change this" is asking about the tool
    // it is holding.
    role: editable ? settingEditRole(entry.key) : null,
    appliesToRunsInFlight: requiresRedeploy ? "after redeploy" : entry.appliesToRunsInFlight,
    requiresRedeploy,
  };
}

type SettingsListData = { settings: SettingView[] };
type SettingsGetData = {
  setting: SettingView;
  versions: SettingsVersionView[];
  /** Whether changes older than the last one listed exist. */
  hasMore: boolean;
};

/** The entry for one key, refused the way the history is refused when the key is
 *  not a setting: a typo answered with an empty shape reads as "nothing is
 *  configured here". */
async function settingOrRefuse(key: string): Promise<SettingsEntryView> {
  const entry = (await readSettings()).settings.find(
    (candidate) => candidate.key === key,
  );
  if (!entry) {
    throw new McpPublicError(
      "VALIDATION_FAILED",
      `Invalid settings: ${key} (unknown_key)`,
      false,
      undefined,
      true,
    );
  }
  return entry;
}

export function registerSettingsTools(
  server: McpServer,
  deps: McpToolDependencies,
): void {
  registerCatalogTool(server, "settings.list", async () => {
    const envelope = await executeMcpRead({
      deps,
      toolName: "settings.list",
      targetRefs: [],
      operation: async (): Promise<SettingsListData> => ({
        settings: (await readSettings()).settings.map(viewOf),
      }),
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "settings.get", async (input) => {
    const envelope = await executeMcpRead({
      deps,
      toolName: "settings.get",
      targetRefs: [input.key],
      operation: async (): Promise<SettingsGetData> => {
        const entry = await settingOrRefuse(input.key);
        try {
          const history = await readSettingsHistoryPage({
            key: input.key,
            limit: input.limit ?? HISTORY_PAGE_DEFAULT,
            before: input.before,
          });
          return {
            setting: viewOf(entry),
            versions: history.versions,
            hasMore: history.hasMore,
          };
        } catch (error) {
          throwPublicSettingsError(error);
        }
      },
    });
    // No trust override: a reason is typed by an operator and a string setting
    // holds whatever they configured, so the default external_untrusted is the
    // honest label for both.
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "settings.set", async (input) => {
    const envelope = await executeMcpMutation({
      deps,
      toolName: "settings.set",
      targetRefs: [input.key],
      idempotencyKey: input.idempotencyKey,
      payloadHash: hashCanonicalJson(input),
      operation: async () => {
        // Checked before the store, because the store would happily write it.
        // The message names where the key IS changed, which is the only part of
        // this refusal a caller can act on.
        const refusal = settingMcpEditRefusal(input.key);
        if (refusal !== null) {
          throw new McpPublicError("VALIDATION_FAILED", refusal, false, undefined, true);
        }
        try {
          const written = await updateSettings({
            patch: { [input.key]: input.value },
            actor: deps.actor.userId ?? deps.actor.subject,
            reason: input.reason,
          });
          const entry = written.settings.find(
            (candidate) => candidate.key === input.key,
          );
          return {
            // Refused above if the key is unknown to the registry, and
            // readSettings enumerates the registry, so this cannot be missing.
            setting: entry ? viewOf(entry) : null,
            // Empty when the key already held this value: the store skips a
            // write that changes nothing, so the history records decisions
            // rather than form submissions. Not an error, and the setting above
            // still says what is in force.
            versions: written.versions,
          };
        } catch (error) {
          throwPublicSettingsError(error);
        }
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "settings.reset", async (input) => {
    const envelope = await executeMcpMutation({
      deps,
      toolName: "settings.reset",
      targetRefs: [input.key],
      idempotencyKey: input.idempotencyKey,
      payloadHash: hashCanonicalJson(input),
      operation: async () => {
        // Checked before the store, because the store would happily write it.
        // The message names where the key IS changed, which is the only part of
        // this refusal a caller can act on.
        const refusal = settingMcpEditRefusal(input.key);
        if (refusal !== null) {
          throw new McpPublicError("VALIDATION_FAILED", refusal, false, undefined, true);
        }
        try {
          const outcome = await resetSetting({
            key: input.key,
            actor: deps.actor.userId ?? deps.actor.subject,
            reason: input.reason,
          });
          return { removed: outcome.removed, setting: viewOf(outcome.entry) };
        } catch (error) {
          throwPublicSettingsError(error);
        }
      },
    });
    return mcpEnvelopeResult(envelope);
  });
}
