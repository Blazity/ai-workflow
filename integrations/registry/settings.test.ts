/**
 * The joined settings list every settings surface serves: core's registry and
 * every setting an integration of this build declares.
 *
 * A key in it twice is one row in the settings store read two ways, and the
 * lookup keeps whichever came last, so a setting would silently answer for
 * another. Conformance refuses a collision inside one manifest; this holds
 * the whole list, core's keys included, and the lookup to it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { integrationSettingDefinitions, settingDefinition, settingDefinitions } from "./index";

test("every setting this build has is under a key of its own", () => {
  const keys = settingDefinitions.map((definition) => definition.key);
  const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
  assert.deepEqual(repeated, [], `stored under the same key twice: ${repeated.join(", ")}`);
});

test("no integration's setting takes a key of core's", () => {
  // Core's own are every group but the one integrations' settings are filed in.
  const core = new Set(
    settingDefinitions
      .filter((definition) => definition.group !== "integrations")
      .map((definition) => definition.key),
  );
  assert.ok(core.has("MAX_CONCURRENT_AGENTS"), "core's registry is in the joined list");
  const taken = integrationSettingDefinitions.filter((definition) => core.has(definition.key));
  assert.deepEqual(taken.map((definition) => definition.key), []);
});

test("the lookup answers every key of the list with that key's own definition", () => {
  for (const definition of settingDefinitions) {
    assert.equal(settingDefinition(definition.key), definition, definition.key);
  }
  assert.equal(settingDefinition("NOT_A_SETTING"), undefined);
});
