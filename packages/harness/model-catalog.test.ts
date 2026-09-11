import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  DEFAULT_MODELS,
  builtinHarnessProfileReference,
  isRecognisedModel,
  recognised,
  resolveModelDefaults,
  resolveBuiltinHarnessProfile,
  selectable,
} from "./model-catalog";

test("recognised records the exact provider-specific policy union", () => {
  assert.deepEqual(recognised, {
    claude: [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ],
    codex: ["gpt-5.4", "gpt-5", "gpt-5-mini"],
  });
  assert.deepEqual(DEFAULT_MODELS, {
    claude: "claude-opus-4-8",
    codex: "gpt-5.4",
  });
  assert.deepEqual(resolveModelDefaults({}), DEFAULT_MODELS);
  assert.deepEqual(
    resolveModelDefaults({ claude: "operator-claude", codex: "operator-codex" }),
    { claude: "operator-claude", codex: "operator-codex" },
  );
});

test("selectable preserves the pre-extraction Claude picker sequence", () => {
  assert.deepEqual(
    selectable({
      provider: "claude",
      modelIds: ["claude-sonnet-5", "claude-opus-4-8"],
    }),
    ["claude-sonnet-5", "claude-opus-4-8"],
  );
});

test("selectable preserves the pre-extraction Codex picker sequence", () => {
  assert.deepEqual(
    selectable({
      provider: "codex",
      modelIds: ["gpt-5.4", "gpt-5", "gpt-5-mini"],
    }),
    ["gpt-5.4", "gpt-5", "gpt-5-mini"],
  );
});

test("selectable does not widen to provider-advertised IDs outside policy", () => {
  assert.deepEqual(
    selectable({
      provider: "codex",
      modelIds: ["gpt-5.4", "gpt-5.5", "o3-codex"],
    }),
    ["gpt-5.4"],
  );
});

test("selectable preserves advertisement order and removes duplicates", () => {
  assert.deepEqual(
    selectable({
      provider: "claude",
      modelIds: [
        "claude-haiku-4-5",
        "claude-opus-4-8",
        "claude-haiku-4-5",
        "claude-fable-5",
      ],
    }),
    ["claude-haiku-4-5", "claude-opus-4-8", "claude-fable-5"],
  );
});

test("unknown stored IDs are not recognised but remain ordinary strings", () => {
  const historicalId = "claude-retired-custom";
  assert.equal(isRecognisedModel("claude", historicalId), false);
  assert.equal(historicalId, "claude-retired-custom");
});

test("built-in compatibility manifests and helpers use catalog defaults", () => {
  const claude =
    BUILTIN_HARNESS_PROFILE_MANIFESTS[BUILTIN_HARNESS_PROFILE_IDS.claude];
  const codex =
    BUILTIN_HARNESS_PROFILE_MANIFESTS[BUILTIN_HARNESS_PROFILE_IDS.codex];
  assert.equal(claude.model.id, DEFAULT_MODELS.claude);
  assert.equal(codex.model.id, DEFAULT_MODELS.codex);
  assert.equal(Object.isFrozen(claude), true);
  assert.deepEqual(builtinHarnessProfileReference("codex"), {
    profileId: BUILTIN_HARNESS_PROFILE_IDS.codex,
    version: codex.version,
  });
  assert.equal(
    resolveBuiltinHarnessProfile({
      profileId: BUILTIN_HARNESS_PROFILE_IDS.codex,
      version: codex.version,
    }),
    codex,
  );
  assert.equal(
    resolveBuiltinHarnessProfile({
      profileId: "historical-custom-profile",
      version: 1,
    }),
    null,
  );
});
