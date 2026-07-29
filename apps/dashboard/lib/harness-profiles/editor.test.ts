import assert from "node:assert/strict";
import test from "node:test";

import {
  canEditProfile,
  draftFromManifest,
  isProfileSlug,
  newProfileDraft,
  upgradeProfileDraft,
  upsertProfile,
  withHarnessModel,
  withHarnessProvider,
} from "./editor";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  type HarnessCapabilitiesResponse,
  type HarnessProfileDto,
} from "@shared/contracts";

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
  assert.equal(next.model.id, "claude-opus-4-6");
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
    id: "claude-supported",
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
    "claude-supported",
  );

  assert.ok(selected);
  assert.deepEqual(selected.model, {
    id: "claude-supported",
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

test("profile slugs match the worker-owned public constraint", () => {
  assert.equal(isProfileSlug("review-agent-2"), true);
  assert.equal(isProfileSlug("-review"), false);
  assert.equal(isProfileSlug("Review"), false);
  assert.equal(isProfileSlug("a".repeat(65)), false);
});
