import assert from "node:assert/strict";
import test from "node:test";

import type { RepositoryProfileVersion } from "@shared/contracts";

import {
  NOTHING_CHANGED_BLOCKER,
  REASON_MISSING_BLOCKER,
  buildProfileUpsert,
  changedProfileFields,
  draftFromProfile,
  isProfileDirty,
  profileSaveBlocker,
} from "./profile";

const REPOSITORY = {
  provider: "github" as const,
  path: "acme/web",
  displayName: "Storefront",
  defaultBranch: "main",
};

const PROFILE: RepositoryProfileVersion = {
  version: 3,
  description: "The storefront.",
  rules: "Never touch the payment module.",
  relationships: [{ repositoryId: 9, label: "calls" }],
  scriptGroups: {
    provider: "github",
    repoPath: "acme/web",
    groups: { test: { commands: ["pnpm test"] } },
  },
  gateGroups: ["test"],
  checksVersion: 2,
  actorId: "u1",
  actorLabel: "Filip",
  reason: "first profile",
  createdAt: "2026-09-10T10:00:00.000Z",
};

test("a repository with no profile yet opens on an empty draft rather than nothing", () => {
  assert.deepEqual(draftFromProfile(null), {
    description: "",
    rules: "",
    relationships: [],
    scriptGroups: null,
    gateGroups: null,
  });
});

test("the draft is a copy, so editing it cannot reach back into the loaded profile", () => {
  const draft = draftFromProfile(PROFILE);
  draft.relationships.push({ repositoryId: 1, label: "x" });
  assert.equal(PROFILE.relationships.length, 1);
});

test("only the fields an edit actually moves are reported as changed", () => {
  const saved = draftFromProfile(PROFILE);
  assert.deepEqual(changedProfileFields(saved, saved), []);
  assert.equal(isProfileDirty(saved, saved), false);

  assert.deepEqual(
    changedProfileFields(saved, { ...saved, rules: "Never touch payments." }),
    ["rules"],
  );
  assert.deepEqual(
    changedProfileFields(saved, {
      ...saved,
      scriptGroups: {
        provider: "github",
        repoPath: "acme/web",
        groups: { test: { commands: ["pnpm test", "pnpm lint"] } },
      },
    }),
    ["scriptGroups"],
  );
});

test("saving one tab carries every other field forward, because an omitted field is stored empty", () => {
  const saved = draftFromProfile(PROFILE);
  const body = buildProfileUpsert({
    repository: REPOSITORY,
    saved,
    draft: { ...saved, rules: "Never touch payments." },
    reason: "tighter wording",
  });

  assert.equal(body.rules, "Never touch payments.");
  assert.equal(
    body.description,
    "The storefront.",
    "the upsert schema defaults an omitted description to the empty string",
  );
  assert.deepEqual(body.relationships, PROFILE.relationships);
  assert.deepEqual(body.scriptGroups, PROFILE.scriptGroups);
  assert.deepEqual(body.gateGroups, ["test"]);
  assert.equal(body.reason, "tighter wording");
});

test("identity comes off the stored row, and the body never grants access", () => {
  const saved = draftFromProfile(PROFILE);
  const body = buildProfileUpsert({
    repository: REPOSITORY,
    saved,
    draft: { ...saved, description: "New." },
    reason: "why",
  });

  assert.equal(body.provider, "github");
  assert.equal(body.path, "acme/web");
  assert.equal(
    "enabled" in body,
    false,
    "writing a profile says what to run, never that the agent may enter the repository",
  );
});

test("a profile that clears its scripts sends null rather than dropping the field", () => {
  const saved = draftFromProfile(PROFILE);
  const body = buildProfileUpsert({
    repository: REPOSITORY,
    saved,
    draft: { ...saved, scriptGroups: null, gateGroups: null },
    reason: "no checks here any more",
  });

  assert.equal(body.scriptGroups, null);
  assert.equal(body.gateGroups, null);
});

test("Save is blocked without a change, without a reason, and without the role", () => {
  assert.equal(
    profileSaveBlocker({ changed: [], reason: "x", canEdit: true }),
    NOTHING_CHANGED_BLOCKER,
  );
  assert.equal(
    profileSaveBlocker({ changed: ["rules"], reason: "   ", canEdit: true }),
    REASON_MISSING_BLOCKER,
  );
  assert.equal(profileSaveBlocker({ changed: ["rules"], reason: "why", canEdit: true }), null);
  assert.ok(
    profileSaveBlocker({ changed: ["rules"], reason: "why", canEdit: false })?.includes("role"),
  );
});
