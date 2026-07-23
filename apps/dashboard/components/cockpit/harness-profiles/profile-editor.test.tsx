import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProfileEditor, parseHomeFiles } from "./profile-editor";
import type {
  HarnessProfileDetailResponse,
  HarnessProfileDto,
} from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
} from "@shared/contracts";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function profile(
  overrides: Partial<HarnessProfileDto> = {},
): HarnessProfileDto {
  const {
    profileId: _profileId,
    version: _version,
    slug: _slug,
    system: _system,
    ...draft
  } = structuredClone(
    BUILTIN_HARNESS_PROFILE_MANIFESTS[
      BUILTIN_HARNESS_PROFILE_IDS.codex
    ],
  );
  return {
    id: "profile-1",
    organizationId: "org-1",
    slug: "custom-codex",
    system: false,
    readOnly: false,
    archivedAt: null,
    draftRevision: 1,
    draftRestoredFromVersion: null,
    publishedVersion: null,
    draft,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    createdById: "user-1",
    updatedById: "user-1",
    ...overrides,
  };
}

function render(profileValue: HarnessProfileDto, canManageProfile: boolean) {
  const detail: HarnessProfileDetailResponse = {
    profile: profileValue,
    published: null,
    versions: [],
    canManageProfile,
  };
  return renderToStaticMarkup(
    <ProfileEditor
      detail={detail}
      canManageProfiles={canManageProfile}
      busy={null}
      error={null}
      onSave={async () => undefined}
      onPublish={async () => undefined}
      onFork={async () => undefined}
      onArchive={async () => undefined}
      onRestore={async () => undefined}
      onRefreshSkill={async () => undefined}
      onDirtyChange={() => undefined}
    />,
  );
}

function inputByLabel(html: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(`<input[^>]*aria-label="${escaped}"[^>]*>`),
  );
  assert.ok(match, `Expected an input labelled "${label}"`);
  return match[0];
}

test("editable profiles expose the complete manifest and GitHub skill authoring", () => {
  const html = render(profile(), true);
  assert.match(html, /Identity and harness/);
  assert.match(html, /Instructions and context/);
  assert.match(html, /Limits and workspace/);
  assert.match(html, /Declared capabilities/);
  assert.match(html, /Safe home files/);
  assert.match(html, /Add skills from GitHub/);
  assert.match(html, /Provider default/);
  assert.match(html, /None available/);
  assert.match(html, /filesystem/);
  assert.match(html, /openai/);
  assert.match(html, /Save draft/);
  assert.match(html, /Publish/);
  assert.doesNotMatch(html, /preset/i);
});

test("unsupported runtime declarations stay readable but cannot be edited", () => {
  const html = render(profile(), true);

  assert.match(
    inputByLabel(
      html,
      "Always include repository AGENTS.md / CLAUDE.md instructions",
    ),
    /disabled/,
  );
  assert.match(inputByLabel(html, "Model options"), /disabled/);
  assert.match(inputByLabel(html, "Compaction"), /disabled/);
  assert.match(inputByLabel(html, "Workspace mode"), /disabled/);
  assert.match(
    inputByLabel(html, "Profile requests subagents"),
    /disabled/,
  );
  assert.match(
    inputByLabel(html, "Declared maximum concurrent subagents"),
    /disabled/,
  );
  for (const tool of ["filesystem", "shell", "git"]) {
    assert.match(inputByLabel(html, tool), /disabled/);
  }
  assert.match(html, /Current provider adapters always clip subagent access/);
  assert.match(html, /complete code-owned set/);
});

test("workspace reuse remains editable because the runtime enforces it", () => {
  const html = render(profile(), true);
  assert.doesNotMatch(
    inputByLabel(
      html,
      "Reuse the managed scratch workspace across compatible blocks",
    ),
    /disabled/,
  );
  assert.match(html, /fresh scratch workspace per invocation/);
});

test("home-file parsing accepts only the provider-owned runtime file", () => {
  assert.deepEqual(
    parseHomeFiles(
      JSON.stringify([
        { path: "AGENTS.md", content: "Project rules", mode: 0o644 },
      ]),
      "codex",
    ),
    [{ path: "AGENTS.md", content: "Project rules", mode: 0o644 }],
  );
  assert.equal(
    parseHomeFiles(
      JSON.stringify([
        { path: "CLAUDE.md", content: "Wrong provider", mode: 0o644 },
      ]),
      "codex",
    ),
    null,
  );
  assert.equal(
    parseHomeFiles(
      JSON.stringify([
        { path: "AGENTS.md", content: "Executable", mode: 0o755 },
      ]),
      "codex",
    ),
    null,
  );
  assert.equal(
    parseHomeFiles(
      JSON.stringify([
        {
          path: "AGENTS.md",
          content: "Unexpected configuration",
          mode: 0o644,
          executable: true,
        },
      ]),
      "codex",
    ),
    null,
  );
  assert.equal(
    parseHomeFiles(
      JSON.stringify([
        { path: "AGENTS.md", content: "First", mode: 0o644 },
        { path: "AGENTS.md", content: "Second", mode: 0o644 },
      ]),
      "codex",
    ),
    null,
  );
});

test("system profiles are visibly read-only but remain forkable", () => {
  const html = render(
    profile({
      id: BUILTIN_HARNESS_PROFILE_IDS.codex,
      organizationId: null,
      system: true,
      readOnly: true,
    }),
    true,
  );
  assert.match(html, /system profile is read-only/i);
  assert.match(html, />Fork</);
  assert.doesNotMatch(html, />Save draft</);
});

test("archived profiles explain selection compatibility without edit actions", () => {
  const html = render(
    profile({ archivedAt: "2026-07-23T12:00:00.000Z" }),
    true,
  );
  assert.match(html, /Existing pinned workflows keep working/);
  assert.match(html, /cannot be changed or newly selected/);
  assert.doesNotMatch(html, />Save draft</);
});
