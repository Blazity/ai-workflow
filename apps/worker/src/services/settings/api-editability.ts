/**
 * Which settings a generic write may touch, and which have a screen of their
 * own.
 *
 * Lifted out of `routes/api/v1/settings.patch.ts`, which had it inline, because
 * a second surface now asks the same question: the MCP `settings.set` tool. The
 * store can write every registry key, so this is the only thing standing
 * between a one-line patch and a decision that has a dialog for a reason, and
 * two copies of it would be two answers.
 *
 * Today the group is `repositories`, which holds the catalog activation flag.
 * Activating decides what the agent may touch at all, and the surface that does
 * it names every repository that stops passing and every one holding a run
 * claim first. A generic patch would flip the same flag with none of that shown.
 *
 * The MCP surface refuses one group MORE than the HTTP one, and the difference
 * is not squeamishness: the `mcp` group IS that surface. A tool that could
 * write `MCP_ENABLED` could switch the transport off mid-session and leave
 * nobody able to switch it back except through the dashboard; one that could
 * write `MCP_TOOL_TIMEOUT_MS` or either rate limit could raise the ceilings it
 * is being held to. Neither is a decision for the caller being limited, so the
 * refusal names the dashboard Settings page, which is a person on a session
 * this transport cannot reach.
 */
import { findSettingDefinition } from "@shared/contracts";

const NON_PATCHABLE_GROUP = "repositories";
/** The group no tool on the MCP surface may write: this transport's own
 *  configuration. Editable through the dashboard, and through the HTTP patch
 *  the dashboard calls; not by an agent talking to the thing it configures. */
const NON_MCP_WRITABLE_GROUP = "mcp";
/**
 * And the one key that belongs with that group but is not filed under it.
 *
 * `MCP_ENABLED` sits in `features` because that is where the dashboard shows
 * it, next to the other switches that turn a capability on. It is still the
 * switch that decides whether this transport answers at all, so a client
 * writing it could close the door it is standing in and leave nobody able to
 * reopen it from here. Named rather than reached by a prefix match: a rule that
 * refused every key starting with "MCP_" would refuse keys nobody has added yet
 * for reasons nobody wrote down.
 */
const NON_MCP_WRITABLE_KEYS: ReadonlySet<string> = new Set(["MCP_ENABLED"]);

/** Whether a generic settings write may store this key. An unknown key is not
 *  this function's refusal: `validateSettingsPatch` names it `unknown_key`, and
 *  answering "not editable" here would send the caller looking for a screen
 *  that does not exist. */
export function isSettingEditableThroughApi(key: string): boolean {
  const definition = findSettingDefinition(key);
  return definition === undefined || definition.group !== NON_PATCHABLE_GROUP;
}

/** Every key of this patch the rule above refuses, named rather than counted,
 *  so a form that submits a whole group hears about all of them at once. */
export function settingsNotEditableThroughApi(
  patch: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(patch).filter((key) => !isSettingEditableThroughApi(key));
}

/** Who may store a setting the rule above allows. One answer for every key
 *  today; it is published rather than assumed so a surface listing the registry
 *  can say it instead of each client deciding. */
export const SETTINGS_EDIT_ROLE = "owner_or_admin" as const;

/** The role that may write a key, or null for a key no API write may store. */
export function settingEditRole(key: string): typeof SETTINGS_EDIT_ROLE | null {
  return isSettingEditableThroughApi(key) ? SETTINGS_EDIT_ROLE : null;
}

/** Whether a tool on the MCP surface may write this key: everything the HTTP
 *  patch may write, minus this transport's own group. */
export function isSettingEditableThroughMcp(key: string): boolean {
  const definition = findSettingDefinition(key);
  return (
    isSettingEditableThroughApi(key) &&
    !NON_MCP_WRITABLE_KEYS.has(key) &&
    (definition === undefined || definition.group !== NON_MCP_WRITABLE_GROUP)
  );
}

/**
 * Why this key cannot be written from MCP, and where it is written instead, or
 * null when it can be.
 *
 * One message per reason rather than one refusal for both, because the two
 * point at different places: the catalog switch has a tool of its own on this
 * very surface, and the transport's own settings have a screen a person has to
 * be sitting in front of.
 */
export function settingMcpEditRefusal(key: string): string | null {
  if (isSettingEditableThroughMcp(key)) return null;
  if (!isSettingEditableThroughApi(key)) {
    return `Not editable here: ${key}. Activating the repository catalog is repositories.activate, which refuses until you have read repositories.activate_preview and can see what stops passing.`;
  }
  return `Not editable here: ${key}. It configures this transport itself -- whether it answers at all, its timeouts and its rate limits -- so it is changed on the dashboard Settings page and not by a client talking through it.`;
}
