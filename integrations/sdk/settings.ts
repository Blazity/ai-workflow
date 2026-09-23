/**
 * How an integration's operator settings become settings of the deployment.
 *
 * A manifest declares what it reads (`IntegrationManifest.settings`); core's
 * settings system stores, validates, versions and serves every setting from
 * one list of `SettingDefinition`s. This is the one translation between the
 * two, so the Settings page, the MCP tools, the settings history and the value
 * a webhook's `ctx.settings` carries all read one description of a setting.
 */
import { SETTINGS_REGISTRY, type SettingDefinition } from "@shared/contracts";
import {
  type IntegrationManifest,
  type IntegrationSetting,
  integrationSettingKey,
} from "./manifest";

/**
 * One setting as the settings registry describes it.
 *
 * Every integration setting applies immediately: the only code that reads one
 * is a webhook, which loads the settings when its request arrives, and nothing
 * inside a run reads one. It is filed in the `integrations` group, and its
 * description is prefixed with the integration's name, because the Settings
 * page lists every integration's settings in that one panel.
 */
export function integrationSettingDefinition(
  manifest: Pick<IntegrationManifest, "id" | "name">,
  setting: IntegrationSetting,
): SettingDefinition {
  return {
    key: integrationSettingKey(manifest.id, setting.key),
    group: "integrations",
    type: setting.type,
    default: setting.default,
    description: `${manifest.name}: ${setting.description}`,
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
    ...(setting.env ? { environmentVariable: setting.env } : {}),
  };
}

/** Every setting these integrations declare, in manifest order. */
export function integrationSettingDefinitionsOf(
  manifests: readonly IntegrationManifest[],
): SettingDefinition[] {
  return manifests.flatMap((manifest) =>
    (manifest.settings ?? []).map((setting) => integrationSettingDefinition(manifest, setting)),
  );
}

/**
 * Core's registry and then every setting these integrations declare: the list
 * a deployment's settings surfaces serve. `@integrations/registry` applies it
 * to the build's manifests as `settingDefinitions`; nothing else joins the two.
 */
export function settingDefinitionsOf(
  manifests: readonly IntegrationManifest[],
): readonly SettingDefinition[] {
  return [...SETTINGS_REGISTRY, ...integrationSettingDefinitionsOf(manifests)];
}

/**
 * `ctx.settings` for one integration, read out of a resolved settings snapshot
 * by the keys this file derives.
 *
 * A key the snapshot does not carry throws rather than answering with the
 * default. The snapshot core loads for a request resolves every declared
 * setting, stored row, variable and default included, so a missing key means
 * the snapshot came from somewhere that did not load them; for an allowlist
 * the default is "everyone", which is the one wrong answer that would pass
 * unnoticed.
 */
export function integrationSettingValues(
  manifest: Pick<IntegrationManifest, "id" | "settings">,
  snapshot: Readonly<Record<string, unknown>>,
): Record<string, readonly string[]> {
  const values: Record<string, readonly string[]> = {};
  for (const setting of manifest.settings ?? []) {
    const key = integrationSettingKey(manifest.id, setting.key);
    const value = snapshot[key];
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
      throw new Error(
        `The settings snapshot carries no list for ${key}, so ${manifest.id}'s ${setting.key} cannot be read`,
      );
    }
    values[setting.key] = value as readonly string[];
  }
  return values;
}
