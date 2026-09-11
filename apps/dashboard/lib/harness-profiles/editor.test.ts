import assert from "node:assert/strict";
import test from "node:test";

import {
  canEditProfile,
  draftFromManifest,
  isProfileSlug,
  newProfileDraft,
  selectableHarnessModels,
  upgradeProfileDraft,
  upsertProfile,
  withHarnessModel,
  withHarnessProvider,
} from "./editor";
import {
  type HarnessCapabilitiesResponse,
  type HarnessProfileDto,
} from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
} from "@shared/harness";

function profile(overrides: Partial<HarnessProfileDto> = {}): HarnessProfileDto {
  return {
    id: "profile-1",
    organizationId: "org-1",
    slug: "review",
    system: false,
    readOnly: false,
    archivedAt: null,
    draftRevision: 1,
    draftRestoredFromVersion: null,
    publishedVersion: null,
    draft: newProfileDraft("codex"),
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    createdById: "user-1",
    updatedById: "user-1",
    ...overrides,
  };
}

function modelCapability(
  id: string,
): HarnessCapabilitiesResponse["models"][number] {
  return {
    id,
    name: id,
    description: null,
    contextWindowTokens: 200_000,
    reasoningEfforts: [{ id: "high", name: "High", description: null }],
    defaultReasoningEffort: "high",
    serviceTiers: [{ id: "standard", name: "Standard", description: null }],
    defaultServiceTier: "standard",
    verbosityOptions: [],
    defaultVerbosity: null,
    compactionModes: ["model_default"],
  };
}

test("manifest copies become editable drafts without immutable identity", () => {
  const draft = draftFromManifest(
    BUILTIN_HARNESS_PROFILE_MANIFESTS[
      BUILTIN_HARNESS_PROFILE_IDS.codex
    ],
  );
  assert.equal(draft.harness.provider, "codex");
  assert.equal("profileId" in draft, false);
  assert.equal("version" in draft, false);
  assert.notEqual(
    draft,
    BUILTIN_HARNESS_PROFILE_MANIFESTS[
      BUILTIN_HARNESS_PROFILE_IDS.codex
    ],
  );
});

test("system, read-only, archived, and unauthorized profiles cannot be edited", () => {
  assert.equal(canEditProfile(profile(), true), true);
  assert.equal(canEditProfile(profile({ system: true }), true), false);
  assert.equal(canEditProfile(profile({ readOnly: true }), true), false);
  assert.equal(
    canEditProfile(profile({ archivedAt: "2026-07-23T00:00:00.000Z" }), true),
    false,
  );
  assert.equal(canEditProfile(profile(), false), false);
});

test("profile upserts remain deterministic", () => {
  const before = [profile()];
  const changed = profile({ draftRevision: 2 });
  assert.equal(upsertProfile(before, changed)[0]?.draftRevision, 2);
});

test("switching providers applies one complete code-owned harness contract", () => {
  const next = withHarnessProvider(
    {
      ...newProfileDraft("codex"),
      homeFiles: [
        { path: "AGENTS.md", content: "Shared instructions", mode: 0o644 },
      ],
    },
    "claude",
  );
  assert.ok(next);
  assert.equal(next.schemaVersion, 1);
  if (next.schemaVersion !== 1) throw new Error("Expected a v1 draft");
  assert.deepEqual(next.harness, {
    provider: "claude",
    packageName: "@anthropic-ai/claude-code",
    cliVersion: "2.1.216",
    protocolVersion: "claude-json-2.1.216",
  });
  assert.equal(next.model.id, "claude-opus-4-8");
  assert.deepEqual(next.model.options, {});
  assert.deepEqual(next.homeFiles, [
    { path: "CLAUDE.md", content: "Shared instructions", mode: 0o644 },
  ]);
  assert.deepEqual(next.credentialReferences, ["anthropic"]);
});

test("switching a v2 profile requires fresh target capabilities and remains v2", () => {
  const capabilities = (
    provider: "codex" | "claude",
    modelId: string,
  ): HarnessCapabilitiesResponse => {
    const baseline = newProfileDraft(provider);
    return {
      ...baseline.harness,
      provider,
      models: [
        {
          id: modelId,
          name: modelId,
          description: null,
          contextWindowTokens: 200_000,
          reasoningEfforts: [
            { id: "high", name: "High", description: null },
          ],
          defaultReasoningEffort: "high",
          serviceTiers: [
            { id: "standard", name: "Standard", description: null },
          ],
          defaultServiceTier: "standard",
          verbosityOptions: [],
          defaultVerbosity: null,
          compactionModes: ["model_default", "custom_threshold"],
        },
      ],
      catalogHash: `${provider}-catalog`,
      fetchedAt: "2026-07-28T00:00:00.000Z",
      stale: false,
      refreshFailure: null,
    };
  };
  const codexDraft = newProfileDraft("codex");
  const v2 = upgradeProfileDraft(
    codexDraft,
    capabilities("codex", codexDraft.model.id),
  );
  assert.ok(v2);

  assert.equal(withHarnessProvider(v2, "claude"), null);
  const claudeDraft = newProfileDraft("claude");
  const switched = withHarnessProvider(
    v2,
    "claude",
    capabilities("claude", claudeDraft.model.id),
  );
  assert.ok(switched);
  assert.equal(switched.schemaVersion, 2);
  assert.equal(switched.harness.provider, "claude");
  assert.equal(switched.model.id, claudeDraft.model.id);
});

test("selecting an advertised model pins its exact capability snapshot and controls", () => {
  const draft = newProfileDraft("claude");
  const model: HarnessCapabilitiesResponse["models"][number] = {
    id: "claude-sonnet-5",
    name: "Claude Supported",
    description: null,
    contextWindowTokens: 200_000,
    reasoningEfforts: [
      { id: "medium", name: "Medium", description: null },
      { id: "high", name: "High", description: null },
    ],
    defaultReasoningEffort: null,
    serviceTiers: [
      { id: "standard", name: "Standard", description: null },
    ],
    defaultServiceTier: "standard",
    verbosityOptions: [],
    defaultVerbosity: null,
    compactionModes: [
      "model_default",
      "custom_threshold",
      "disabled",
    ],
  };
  const capabilities: HarnessCapabilitiesResponse = {
    ...draft.harness,
    provider: "claude",
    models: [model],
    catalogHash: "catalog-current",
    fetchedAt: "2026-07-29T00:00:00.000Z",
    stale: false,
    refreshFailure: null,
  };

  const selected = withHarnessModel(
    draft,
    capabilities,
    "claude-sonnet-5",
  );

  assert.ok(selected);
  assert.deepEqual(selected.model, {
    id: "claude-sonnet-5",
    reasoning: {
      selection: "medium",
      effectiveEffort: "medium",
    },
    serviceTier: "standard",
    capability: model,
    catalogHash: "catalog-current",
  });
  assert.deepEqual(selected.compaction, { mode: "model_default" });
});

test("an advertised model outside policy stays readable but is not upgraded", () => {
  const draft = {
    ...newProfileDraft("codex"),
    model: { id: "gpt-5.5", options: {} },
  };
  const capabilities: HarnessCapabilitiesResponse = {
    ...draft.harness,
    models: [modelCapability(draft.model.id)],
    catalogHash: "catalog-current",
    fetchedAt: "2026-09-11T00:00:00.000Z",
    stale: false,
    refreshFailure: null,
  };

  assert.equal(upgradeProfileDraft(draft, capabilities), null);
  assert.equal(draft.model.id, "gpt-5.5");
});

test("dashboard model options use the exact catalog intersection sequence", () => {
  const draft = newProfileDraft("codex");
  const capabilities: HarnessCapabilitiesResponse = {
    ...draft.harness,
    models: [
      modelCapability("gpt-5-mini"),
      modelCapability("gpt-5.5"),
      modelCapability("gpt-5.4"),
      modelCapability("gpt-5-mini"),
    ],
    catalogHash: "catalog-current",
    fetchedAt: "2026-09-11T00:00:00.000Z",
    stale: false,
    refreshFailure: null,
  };

  assert.deepEqual(
    selectableHarnessModels(capabilities).map((candidate) => candidate.id),
    ["gpt-5-mini", "gpt-5.4"],
  );
});

test("profile slugs match the worker-owned public constraint", () => {
  assert.equal(isProfileSlug("review-agent-2"), true);
  assert.equal(isProfileSlug("-review"), false);
  assert.equal(isProfileSlug("Review"), false);
  assert.equal(isProfileSlug("a".repeat(65)), false);
});
