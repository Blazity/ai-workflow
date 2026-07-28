import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  RepositoryOption,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import { MAX_PINNED_REPOSITORIES } from "@/lib/workflow-editor/repository-scope";
import {
  RepositoryCatalogProvider,
  type RepositoryCatalogStatus,
} from "./repository-catalog-context";
import { RepositoryScopeBar } from "./repository-scope-bar";
import { RepositoryScopeModal } from "./repository-scope-modal";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function option(overrides: Partial<RepositoryOption> = {}): RepositoryOption {
  return {
    provider: "github",
    repoPath: "Blazity/ai-workflow",
    name: "ai-workflow",
    owner: "Blazity",
    defaultBranch: "main",
    private: true,
    archived: false,
    ...overrides,
  };
}

const catalog = [
  option(),
  option({
    provider: "gitlab",
    repoPath: "group/app",
    name: "app",
    owner: "group",
    defaultBranch: "trunk",
  }),
  option({
    repoPath: "Blazity/legacy",
    name: "legacy",
    defaultBranch: "master",
    archived: true,
  }),
];

function renderBar(
  scope: WorkflowRepositoryScope,
  canEdit = true,
  status: RepositoryCatalogStatus = "ready",
  repositories: RepositoryOption[] = catalog,
): string {
  return renderToStaticMarkup(
    <RepositoryCatalogProvider initial={{ status, repositories }}>
      <RepositoryScopeBar
        scope={scope}
        canEdit={canEdit}
        onChange={() => undefined}
      />
    </RepositoryCatalogProvider>,
  );
}

function renderModal(
  scope: WorkflowRepositoryScope,
  canEdit = true,
  status: RepositoryCatalogStatus = "ready",
  repositories: RepositoryOption[] = catalog,
): string {
  return renderToStaticMarkup(
    <RepositoryCatalogProvider initial={{ status, repositories }}>
      <RepositoryScopeModal
        open
        scope={scope}
        canEdit={canEdit}
        onApply={() => undefined}
        onCancel={() => undefined}
      />
    </RepositoryCatalogProvider>,
  );
}

test("an unpinned workflow renders one compact automatic source-scope summary", () => {
  const html = renderBar({});

  assert.match(html, /Source scope/);
  assert.match(html, /Providers &amp; repositories/);
  assert.match(html, /Automatic provider/);
  assert.match(html, /Automatic per ticket/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, />Configure</);
  assert.doesNotMatch(html, /Add repositories/);
  assert.doesNotMatch(html, /role="dialog"/);
});

test("the compact summary uses equal-height badges for explicit scope", () => {
  const html = renderBar({
    repositories: [
      { provider: "github", repoPath: "Blazity/ai-workflow" },
      { provider: "gitlab", repoPath: "group/app" },
    ],
    providers: ["github", "gitlab"],
  });

  assert.match(html, />GitHub</);
  assert.match(html, />GitLab</);
  assert.match(html, />2 repositories</);
  assert.equal((html.match(/inline-flex h-6/g) ?? []).length, 3);
  assert.match(html, /tabular-nums/);
});

test("the compact summary names attention without expanding detailed warnings", () => {
  const html = renderBar({
    repositories: [{ provider: "github", repoPath: "Blazity/private-thing" }],
  });

  assert.match(html, /role="status"/);
  assert.match(html, /Needs attention/);
  assert.doesNotMatch(html, /Blazity\/private-thing/);
  assert.doesNotMatch(html, /The catalog does not list/);
});

test("read-only mode disables the only collapsed control", () => {
  const html = renderBar(
    {
      repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow" }],
      providers: ["github"],
    },
    false,
  );

  const buttons = html.match(/<button[^>]*>/g) ?? [];
  assert.equal(buttons.length, 1);
  assert.match(buttons[0], /disabled=""/);
  assert.match(html, />1 repository</);
});

test("the modal is named and groups provider and repository controls", () => {
  const html = renderModal({});

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby=/);
  assert.match(html, /Configure source scope/);
  assert.match(html, />Providers</);
  assert.match(html, />Repositories</);
  assert.match(html, />Cancel</);
  assert.match(html, />Apply scope</);
  assert.match(html, /aria-label="Close source scope"/);
});

test("the modal shows selected repositories and catalog rows without nesting another picker", () => {
  const html = renderModal({
    repositories: [{ provider: "gitlab", repoPath: "group/app" }],
  });

  assert.match(html, /aria-label="Selected repositories"/);
  assert.match(html, /aria-label="Remove group\/app"/);
  assert.match(html, /aria-label="Filter repositories"/);
  assert.match(html, /aria-label="Pin Blazity\/ai-workflow"/);
  assert.match(html, /aria-label="Pin group\/app"/);
  assert.match(html, /checked=""/);
  assert.match(html, /Archived in the provider/);
  assert.match(
    html,
    new RegExp(
      `${MAX_PINNED_REPOSITORIES - 1} of ${MAX_PINNED_REPOSITORIES} slots left`,
    ),
  );
  assert.doesNotMatch(html, /aria-label="Add pinned repositories"/);
});

test("detailed mismatch and catalog warnings live inside the modal", () => {
  const mismatch = renderModal({
    repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow" }],
    providers: ["gitlab"],
  });
  assert.match(mismatch, /Provider mismatch/);
  assert.match(mismatch, /Blazity\/ai-workflow \(GitHub\)/);
  assert.match(mismatch, /Deployment rejects this until the two agree/);

  const missing = renderModal({
    repositories: [{ provider: "github", repoPath: "Blazity/private-thing" }],
  });
  assert.match(missing, /The catalog does not list/);
  assert.match(missing, /Blazity\/private-thing/);
  assert.match(missing, /kept exactly as saved/);
  assert.match(missing, /cached for 60 seconds/);
});

test("loading, empty, and failed catalogs remain distinct modal states", () => {
  const loading = renderModal({}, true, "loading", []);
  assert.match(loading, /Loading repositories…/);
  assert.doesNotMatch(loading, /aria-label="Filter repositories"/);
  assert.doesNotMatch(loading, /aria-label="Repository path"/);

  const empty = renderModal({}, true, "ready", []);
  assert.match(empty, /The catalog returned no repositories/);
  assert.match(empty, /aria-label="Repository path"/);
  assert.doesNotMatch(empty, /matches this filter/);

  const failed = renderModal({}, true, "error", []);
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Saved pins are preserved/);
  assert.match(failed, /aria-label="Repository path"/);
  assert.match(
    failed,
    /aria-label="Provider for the manually entered repository"/,
  );
});

test("a closed modal renders nothing", () => {
  const html = renderToStaticMarkup(
    <RepositoryCatalogProvider initial={{ status: "ready", repositories: catalog }}>
      <RepositoryScopeModal
        open={false}
        scope={{}}
        canEdit
        onApply={() => undefined}
        onCancel={() => undefined}
      />
    </RepositoryCatalogProvider>,
  );

  assert.equal(html, "");
});
