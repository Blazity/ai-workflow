import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LocalSkillPinNotice,
  ProfileEditor,
  parseHomeFiles,
  pinsDeploymentSkill,
} from "./profile-editor";
import type {
  HarnessLocalSkillDiscoveryResponse,
  HarnessProfileDetailResponse,
  HarnessProfileDto,
  HarnessSkillSource,
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

function render(
  profileValue: HarnessProfileDto,
  canManageProfile: boolean,
  initialMode: "overview" | "edit" | "review" = "overview",
  skillSources: HarnessProfileDetailResponse["skillSources"] = [],
  refreshNotice: { artifactHash: string; changed: boolean } | null = null,
) {
  const detail: HarnessProfileDetailResponse = {
    profile: profileValue,
    published: null,
    versions: [],
    canManageProfile,
    canDeleteProfile: canManageProfile,
    usage: [],
    skillSources,
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
      onUnarchive={async () => undefined}
      onDelete={async () => undefined}
      onRestore={async () => undefined}
      onRefreshSkill={async () => undefined}
      refreshNotice={refreshNotice}
      onDirtyChange={() => undefined}
      initialMode={initialMode}
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

test("editable profiles expose the complete manifest and skill authoring", () => {
  const html = render(profile(), true, "edit");
  assert.match(html, /Identity and harness/);
  assert.match(html, />Context</);
  assert.match(html, />Instructions</);
  assert.match(html, /Limits and workspace/);
  assert.match(html, /Declared capabilities/);
  assert.match(html, /Safe home files/);
  assert.match(html, /Add skills/);
  assert.match(html, /Provider default/);
  assert.match(html, /gpt-5\.4 · unavailable/);
  assert.match(
    html,
    /Historical selection; choose a current model before publishing/,
  );
  assert.match(html, /None available/);
  assert.match(html, /filesystem/);
  assert.match(html, /openai/);
  assert.match(html, /Save draft/);
  assert.match(html, /Publish/);
  assert.doesNotMatch(html, /preset/i);
});

test("unsupported runtime declarations stay readable but cannot be edited", () => {
  const html = render(profile(), true, "edit");

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
  const html = render(profile(), true, "edit");
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

test("a pinned skill names the source it came from", () => {
  const base = profile();
  const draft = structuredClone(base.draft);
  draft.skills = [
    { artifactHash: "a".repeat(64), name: "from-github" },
    { artifactHash: "b".repeat(64), name: "from-deployment" },
  ];
  const html = render({ ...base, draft }, true, "overview", [
    {
      artifactHash: "a".repeat(64),
      source: {
        owner: "blazity",
        repository: "ai-workflow",
        path: "skills/review",
        commitSha: "c".repeat(40),
      },
    },
    {
      artifactHash: "b".repeat(64),
      source: { path: "review-checklist", contentSha256: "d".repeat(64) },
    },
  ]);

  assert.match(html, /blazity\/ai-workflow @ cccccccccccc/);
  assert.match(html, /This deployment · skills\/review-checklist @ dddddddddddd/);
});

test("refreshing tells a moved pin apart from a deployment carrying the same bytes", () => {
  const base = profile();
  const draft = structuredClone(base.draft);
  draft.skills = [{ artifactHash: "b".repeat(64), name: "from-deployment" }];
  const sources = [
    {
      artifactHash: "b".repeat(64),
      source: { path: "review-checklist", contentSha256: "d".repeat(64) },
    },
  ];

  const updated = render({ ...base, draft }, true, "edit", sources, {
    artifactHash: "b".repeat(64),
    changed: true,
  });
  const unchanged = render({ ...base, draft }, true, "edit", sources, {
    artifactHash: "b".repeat(64),
    changed: false,
  });

  assert.notEqual(updated, unchanged);
  assert.match(updated, /Refreshed: updated to new contents/);
  assert.doesNotMatch(updated, /carries the same contents/);
  assert.match(
    unchanged,
    /Refreshed: this deployment carries the same contents, so the pin is unchanged/,
  );
  assert.doesNotMatch(unchanged, /updated to new contents/);
});

test("a pinned deployment skill reads differently once the deployment moves", () => {
  const localSource: HarnessSkillSource = {
    path: "review-checklist",
    contentSha256: "d".repeat(64),
  };
  const notice = (discovery: HarnessLocalSkillDiscoveryResponse | null) =>
    renderToStaticMarkup(
      <LocalSkillPinNotice
        artifactHash={"b".repeat(64)}
        source={localSource}
        discovery={discovery}
      />,
    );

  const aligned = notice({
    directoryPresent: true,
    skills: [
      {
        name: "review-checklist",
        path: "review-checklist",
        description: null,
        artifactHash: "b".repeat(64),
      },
    ],
    skipped: [],
  });
  const moved = notice({
    directoryPresent: true,
    skills: [
      {
        name: "review-checklist",
        path: "review-checklist",
        description: null,
        artifactHash: "e".repeat(64),
      },
    ],
    skipped: [],
  });
  const gone = notice({
    directoryPresent: true,
    skills: [
      {
        name: "release-notes",
        path: "release-notes",
        description: null,
        artifactHash: "e".repeat(64),
      },
    ],
    skipped: [],
  });

  assert.equal(new Set([aligned, moved, gone]).size, 3);
  assert.match(aligned, /Matches skills\/review-checklist in this deployment/);
  assert.match(
    moved,
    /ships different contents at skills\/review-checklist\. Use Refresh to move the pin/,
  );
  assert.doesNotMatch(moved, /Restore the directory/);
  assert.match(
    gone,
    /no longer ships skills\/review-checklist\. Restore the directory in the repository, or remove this skill/,
  );
  assert.doesNotMatch(gone, /Use Refresh/);
});

test("an unreadable deployment listing is unknown, never drifted", () => {
  const unread = renderToStaticMarkup(
    <LocalSkillPinNotice
      artifactHash={"b".repeat(64)}
      source={{ path: "review-checklist", contentSha256: "d".repeat(64) }}
      discovery={null}
    />,
  );
  const github = renderToStaticMarkup(
    <LocalSkillPinNotice
      artifactHash={"a".repeat(64)}
      source={{
        owner: "blazity",
        repository: "ai-workflow",
        path: "skills/review",
        commitSha: "c".repeat(40),
      }}
      discovery={{ directoryPresent: true, skills: [], skipped: [] }}
    />,
  );

  assert.equal(unread, "");
  assert.equal(github, "");
});

test("only a profile pinning a deployment skill has the deployment to ask", () => {
  const github: HarnessSkillSource = {
    owner: "blazity",
    repository: "ai-workflow",
    path: "skills/review",
    commitSha: "c".repeat(40),
  };
  const local: HarnessSkillSource = {
    path: "review-checklist",
    contentSha256: "d".repeat(64),
  };
  const sources = new Map<string, HarnessSkillSource>([
    ["a".repeat(64), github],
    ["b".repeat(64), local],
  ]);
  const lookup = (artifactHash: string) => sources.get(artifactHash);

  assert.equal(pinsDeploymentSkill([], lookup), false);
  assert.equal(
    pinsDeploymentSkill(
      [{ artifactHash: "a".repeat(64), name: "from-github" }],
      lookup,
    ),
    false,
  );
  assert.equal(
    pinsDeploymentSkill(
      [{ artifactHash: "f".repeat(64), name: "source-unknown" }],
      lookup,
    ),
    false,
  );
  assert.equal(
    pinsDeploymentSkill(
      [
        { artifactHash: "a".repeat(64), name: "from-github" },
        { artifactHash: "b".repeat(64), name: "from-deployment" },
      ],
      lookup,
    ),
    true,
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
  assert.match(html, />Duplicate</);
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
