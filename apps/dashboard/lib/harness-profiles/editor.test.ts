import assert from "node:assert/strict";
import test from "node:test";

import {
  canEditProfile,
  draftFromManifest,
  isProfileSlug,
  newProfileDraft,
  upsertProfile,
  withHarnessProvider,
} from "./editor";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
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

test("profile slugs match the worker-owned public constraint", () => {
  assert.equal(isProfileSlug("review-agent-2"), true);
  assert.equal(isProfileSlug("-review"), false);
  assert.equal(isProfileSlug("Review"), false);
  assert.equal(isProfileSlug("a".repeat(65)), false);
});
