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
  profileSaveErrorNotice,
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
  batchTimeoutMinutes: null,
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
    batchTimeoutMinutes: null,
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

test("saving one tab sends that tab's field and nothing else", () => {
  // The route reads an omitted field as unchanged, so a Rules save must not
  // carry the script groups: sending them would revalidate and rewrite a value
  // nobody edited, and would replace whatever the Scripts tab stored since.
  const saved = draftFromProfile(PROFILE);
  const body = buildProfileUpsert({
    repository: REPOSITORY,
    saved,
    draft: { ...saved, rules: "Never touch payments." },
    reason: "tighter wording",
    expectedProfileVersion: 3,
  });

  assert.equal(body.rules, "Never touch payments.");
  assert.equal("description" in body, false);
  assert.equal("relationships" in body, false);
  assert.equal("scriptGroups" in body, false);
  assert.equal("gateGroups" in body, false);
  assert.equal("batchTimeoutMinutes" in body, false);
  assert.equal(body.reason, "tighter wording");
  assert.equal(body.expectedProfileVersion, 3);
});

test("a save that changes nothing sends no profile field at all", () => {
  const saved = draftFromProfile(PROFILE);
  const body = buildProfileUpsert({
    repository: REPOSITORY,
    saved,
    draft: saved,
    reason: "nothing",
    expectedProfileVersion: 3,
  });

  for (const field of [
    "description",
    "rules",
    "relationships",
    "scriptGroups",
    "gateGroups",
    "batchTimeoutMinutes",
  ]) {
    assert.equal(field in body, false, `${field} must not be on the wire`);
  }
});

test("identity comes off the stored row, and the body never grants access", () => {
  const saved = draftFromProfile(PROFILE);
  const body = buildProfileUpsert({
    repository: REPOSITORY,
    saved,
    draft: { ...saved, description: "New." },
    reason: "why",
    expectedProfileVersion: 3,
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
  // Null and absent mean different things now: absent is unchanged, null is
  // cleared. A tab that cleared its groups has to send the null.
  const saved = draftFromProfile(PROFILE);
  const body = buildProfileUpsert({
    repository: REPOSITORY,
    saved,
    draft: { ...saved, scriptGroups: null, gateGroups: null },
    reason: "no checks here any more",
    expectedProfileVersion: 3,
  });

  assert.equal(body.scriptGroups, null);
  assert.equal(body.gateGroups, null);
});

test("the checks ceiling is a profile field like any other", () => {
  const saved = draftFromProfile(PROFILE);
  assert.deepEqual(
    changedProfileFields(saved, { ...saved, batchTimeoutMinutes: 45 }),
    ["batchTimeoutMinutes"],
  );
  const body = buildProfileUpsert({
    repository: REPOSITORY,
    saved,
    draft: { ...saved, batchTimeoutMinutes: 45 },
    reason: "the suite got longer",
    expectedProfileVersion: 3,
  });
  assert.equal(body.batchTimeoutMinutes, 45);
  assert.equal("rules" in body, false);
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

test("a refused group name names the group and the tab that holds it", () => {
  // Only a save that CARRIES the groups can be refused for them now, so the
  // names are read off the body that was sent rather than from the worker's
  // unqualified error, which says nothing about which group.
  const notice = profileSaveErrorNotice(
    "invalid_script_group_name: Bad Name (must be lower case)",
    {
      provider: "github",
      repoPath: "acme/web",
      groups: { "Bad Name": { commands: ["pnpm test"] } },
    },
  );
  assert.match(notice, /The script group "Bad Name" is not valid/);
  assert.match(notice, /The Scripts tab holds it/);
});

test("a refusal on a save that carried no groups still points at the right tab", () => {
  const notice = profileSaveErrorNotice(
    "invalid_script_group_name: Bad Name (must be lower case)",
    undefined,
  );
  assert.match(notice, /A script group name is not valid/);
  assert.match(notice, /The Scripts tab holds them/);
});

test("any other message is passed through untouched", () => {
  assert.equal(profileSaveErrorNotice("repository_mismatch", null), "repository_mismatch");
});
