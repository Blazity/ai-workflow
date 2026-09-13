import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LocalSkillPinNotice,
  ProfileEditor,
  parseHomeFiles,
  pinsDeploymentSkill,
} from "./profile-editor";
import type {
  HarnessCapabilitiesResponse,
  HarnessLocalSkillDiscoveryResponse,
  HarnessProfileDetailResponse,
  HarnessProfileDto,
  HarnessSkillSource,
} from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
} from "@shared/harness";
import { isGitHubSkillSource } from "@shared/skills";
import { selectableHarnessModels } from "@/lib/harness-profiles/editor";
import { installTestDom } from "@/components/ui/test-dom";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const disabledAttribute = /\sdisabled=""/;

function modelCapability(
  id: string,
): HarnessCapabilitiesResponse["models"][number] {
  return {
    id,
    name: `Name ${id}`,
    description: null,
    contextWindowTokens: null,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    serviceTiers: [],
    defaultServiceTier: null,
    verbosityOptions: [],
    defaultVerbosity: null,
    compactionModes: ["model_default"],
  };
}

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

test("harness profile screen busy skill import ignores Escape and backdrop mouse down", async () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const profileValue = profile();
  const detail: HarnessProfileDetailResponse = {
    profile: profileValue,
    published: null,
    versions: [],
    canManageProfile: true,
    canDeleteProfile: true,
    usage: [],
    skillSources: [],
  };
  let root: Root | undefined;
  let finishRequest: ((response: Response) => void) | undefined;
  const request = new Promise<Response>((resolve) => {
    finishRequest = resolve;
  });
  mock.method(globalThis, "fetch", async () => request);

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ProfileEditor
          detail={detail}
          canManageProfiles
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
          onDirtyChange={() => undefined}
          initialMode="edit"
        />,
      );
    });
    const addSkills = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.trim() === "Add skills",
    );
    assert.ok(addSkills);
    act(() => addSkills.click());
    const dialog = document.querySelector<HTMLElement>(
      '[role="dialog"][data-state="open"]',
    );
    assert.ok(dialog);
    const localSource = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.trim() === "This deployment",
    );
    assert.ok(localSource);
    await act(async () => {
      localSource.click();
      await Promise.resolve();
    });
    assert.equal(localSource.disabled, true);
    assert.equal(dialog.querySelector('[aria-label="Close skill import"]'), null);

    act(() => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(dialog.dataset.state, "open");

    const backdrop = document.querySelector<HTMLElement>("[data-modal-overlay]");
    assert.ok(backdrop);
    act(() => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(dialog.dataset.state, "open");
  } finally {
    act(() => root?.unmount());
    finishRequest?.(Response.json({ skills: [], artifacts: [] }));
    await Promise.resolve();
    container.remove();
    mock.restoreAll();
    dom.restore();
  }
});

test("the rendered Listbox receives the exact filtered model option sequence", () => {
  const harness =
    BUILTIN_HARNESS_PROFILE_MANIFESTS[BUILTIN_HARNESS_PROFILE_IDS.codex]
      .harness;
  const capabilities: HarnessCapabilitiesResponse = {
    ...harness,
    models: [
      modelCapability("gpt-5-mini"),
      modelCapability("gpt-5.5"),
      modelCapability("gpt-5.4"),
    ],
    catalogHash: "catalog-current",
    fetchedAt: "2026-09-11T00:00:00.000Z",
    stale: false,
    refreshFailure: null,
  };

  assert.deepEqual(
    selectableHarnessModels(capabilities).map((model) => model.id),
    ["gpt-5-mini", "gpt-5.4"],
  );
});

test("unsupported runtime declarations stay readable but cannot be edited", () => {
  const html = render(profile(), true, "edit");

  assert.match(
    inputByLabel(
      html,
      "Always include repository AGENTS.md / CLAUDE.md instructions",
    ),
    disabledAttribute,
  );
  assert.match(inputByLabel(html, "Model options"), disabledAttribute);
  assert.match(inputByLabel(html, "Compaction"), disabledAttribute);
  assert.match(inputByLabel(html, "Workspace mode"), disabledAttribute);
  assert.match(
    inputByLabel(html, "Profile requests subagents"),
    disabledAttribute,
  );
  assert.match(
    inputByLabel(html, "Declared maximum concurrent subagents"),
    disabledAttribute,
  );
  for (const tool of ["filesystem", "shell", "git"]) {
    assert.match(inputByLabel(html, tool), disabledAttribute);
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
    disabledAttribute,
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
  assert.match(html, />aaaaaaaaaaaa<\/code>/);
  assert.match(html, /aria-label="Copy full artifact digest a{64}"/);
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

  assert.equal(isGitHubSkillSource(github), true);
  assert.equal(isGitHubSkillSource(local), false);

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
