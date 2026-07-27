import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  RepositoryOption,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import {
  RepositoryScopeBar,
  RepositoryScopePicker,
} from "./repository-scope-bar";
import {
  RepositoryCatalogProvider,
  type RepositoryCatalogStatus,
} from "./repository-catalog-context";
import { MAX_PINNED_REPOSITORIES } from "@/lib/workflow-editor/repository-scope";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

/** Visible text only, so assertions never depend on class strings or tag order. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

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

function renderPicker(
  scope: WorkflowRepositoryScope,
  canEdit = true,
  status: RepositoryCatalogStatus = "ready",
  repositories: RepositoryOption[] = catalog,
): string {
  return renderToStaticMarkup(
    <RepositoryCatalogProvider initial={{ status, repositories }}>
      <RepositoryScopePicker
        open
        scope={scope}
        canEdit={canEdit}
        onAdd={() => undefined}
        onClose={() => undefined}
      />
    </RepositoryCatalogProvider>,
  );
}

test("an unpinned workflow states that every ticket still resolves its own repository", () => {
  const html = renderBar({});

  assert.match(html, /Repositories/);
  assert.match(html, /Pinned for every ticket/);
  assert.match(html, /No repository pinned: every ticket resolves its own/);
  assert.match(html, new RegExp(`0 / ${MAX_PINNED_REPOSITORIES}`));
  assert.match(html, /No provider pinned: the run picks the provider itself/);
});

test("a pinned repository shows its provider, default branch, and inherited providers", () => {
  const html = renderBar({
    repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow" }],
  });

  // The chip reads path, then provider, then default branch. The provider is
  // lowercase in the DOM and uppercased by CSS.
  assert.match(text(html), /Blazity\/ai-workflow github main/);
  assert.match(text(html), new RegExp(`1 / ${MAX_PINNED_REPOSITORIES}`));
  assert.match(html, /aria-label="Remove Blazity\/ai-workflow"/);
  assert.match(html, /Inherited from the pinned repositories: GitHub\./);
  assert.match(html, /inherits 1 repo, GitHub/);
  assert.match(html, /never asks which repository to use/);
  assert.doesNotMatch(html, /unverified/);
});

test("a provider-only pin does not claim the run resolves repositories freely", () => {
  const html = renderBar({ providers: ["github", "gitlab"] });

  assert.match(
    html,
    /No repository pinned: every ticket resolves its own within the pinned providers\./,
  );
  assert.doesNotMatch(html, /as it does today/);
});

test("both providers pinned reads as the multi-repo binding", () => {
  const html = renderBar({
    repositories: [
      { provider: "github", repoPath: "Blazity/ai-workflow" },
      { provider: "gitlab", repoPath: "group/app" },
    ],
    providers: ["github", "gitlab"],
  });

  assert.match(html, /inherits 2 repos, GitHub \+ GitLab/);
  assert.match(html, /aria-pressed="true"[^>]*>GitHub</);
  assert.match(html, /aria-pressed="true"[^>]*>GitLab</);
  assert.match(html, /Both makes a run multi-repo/);
});

test("a pinned repository the catalog does not return stays selected with a warning", () => {
  const html = renderBar({
    repositories: [{ provider: "github", repoPath: "Blazity/private-thing" }],
  });

  assert.match(html, /Blazity\/private-thing/);
  assert.match(html, /unverified/);
  assert.match(html, /The catalog does not list Blazity\/private-thing/);
  assert.match(html, /kept exactly as saved/);
  assert.match(html, /outside the server allowlist/);
  assert.match(html, /cached for 60 seconds/);
  assert.match(html, /aria-label="Remove Blazity\/private-thing"/);
});

test("a still-loading catalog never accuses a saved pin of being missing", () => {
  const html = renderBar(
    { repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow-prod" }] },
    true,
    "loading",
    [],
  );

  assert.match(html, /Blazity\/ai-workflow-prod/);
  assert.match(html, /Checking the pinned repositories against the catalog…/);
  assert.doesNotMatch(html, /unverified/);
  assert.doesNotMatch(html, /The catalog does not list/);
});

test("an archived pin is kept but its reason is stated", () => {
  const html = renderBar({
    repositories: [{ provider: "github", repoPath: "Blazity/legacy" }],
  });

  assert.match(html, /Archived in the provider: Blazity\/legacy/);
  assert.match(html, /cannot open changes there/);
  assert.doesNotMatch(html, /unverified/);
});

test("read-only mode disables every control in the bar", () => {
  const html = renderBar(
    {
      repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow" }],
      providers: ["github"],
    },
    false,
  );

  const buttons = html.match(/<button[^>]*>/g) ?? [];
  assert.equal(buttons.length > 0, true);
  for (const button of buttons) {
    assert.match(button, /disabled=""/);
  }
  assert.match(html, /Blazity\/ai-workflow/);
});

test("a catalog outage still explains that pins survive and can be entered by path", () => {
  const html = renderBar({}, true, "error", []);

  assert.match(html, /The repository catalog is unavailable/);
  assert.match(html, /Saved pins are preserved/);
  assert.match(html, /entered by exact path/);
});

test("the picker offers only catalog repositories, with disabled reasons", () => {
  const html = renderPicker({
    repositories: [{ provider: "gitlab", repoPath: "group/app" }],
  });

  assert.match(html, /aria-label="Add pinned repositories"/);
  assert.match(html, /aria-label="Filter repositories"/);
  assert.match(html, /aria-label="Pin Blazity\/ai-workflow"/);
  assert.match(html, /Already pinned/);
  assert.match(html, /Archived in the provider/);
  assert.match(html, /trunk/);
  assert.match(html, /master/);
  assert.match(
    html,
    new RegExp(`${MAX_PINNED_REPOSITORIES - 1} of ${MAX_PINNED_REPOSITORIES} slots left`),
  );
  assert.match(html, /cached for 60 seconds/);
  assert.match(html, /Refresh catalog/);
});

test("a pinned repository absent from the catalog is never offered by the picker", () => {
  const html = renderPicker({
    repositories: [{ provider: "github", repoPath: "Blazity/private-thing" }],
  });

  assert.doesNotMatch(html, /Blazity\/private-thing/);
});

test("the picker reports no slots left once the workspace limit is reached", () => {
  const html = renderPicker({
    repositories: Array.from({ length: MAX_PINNED_REPOSITORIES }, (_value, index) => ({
      provider: "github" as const,
      repoPath: `owner/repo-${index}`,
    })),
  });

  assert.match(html, new RegExp(`0 of ${MAX_PINNED_REPOSITORIES} slots left`));
  assert.match(html, new RegExp(`Limit of ${MAX_PINNED_REPOSITORIES} reached`));
});

test("an empty catalog is not reported as a filter miss and is not a dead end", () => {
  const html = renderPicker({}, true, "ready", []);

  assert.match(html, /The catalog returned no repositories/);
  assert.doesNotMatch(html, /matches this filter/);
  // Nothing to filter or select, so only the exact-path fallback is offered.
  assert.match(html, /aria-label="Repository path"/);
  assert.doesNotMatch(html, /aria-label="Filter repositories"/);
  assert.doesNotMatch(html, /Add repositories<\/button>/);
});

test("a catalog outage degrades the picker to exact owner/repo entry", () => {
  const html = renderPicker({}, true, "error", []);

  assert.match(html, /role="alert"/);
  assert.match(html, /cannot be browsed/);
  assert.match(html, /aria-label="Repository path"/);
  assert.match(html, /placeholder="owner\/repo"/);
  assert.match(
    html,
    /aria-label="Provider for the manually entered repository"/,
  );
  assert.doesNotMatch(html, /aria-label="Filter repositories"/);
});

test("a loading catalog says so instead of looking like an empty workspace", () => {
  const html = renderPicker({}, true, "loading", []);

  assert.match(html, /Loading repositories…/);
  assert.doesNotMatch(html, /aria-label="Filter repositories"/);
  assert.doesNotMatch(html, /owner\/repo/);
});

test("a closed picker renders nothing", () => {
  const html = renderToStaticMarkup(
    <RepositoryCatalogProvider initial={{ status: "ready", repositories: catalog }}>
      <RepositoryScopePicker
        open={false}
        scope={{}}
        canEdit
        onAdd={() => undefined}
        onClose={() => undefined}
      />
    </RepositoryCatalogProvider>,
  );

  assert.equal(html, "");
});

/** Attribute order is React's to choose, so assert on the whole tag. */
function controlTag(html: string, attribute: string): string {
  const match = html.match(new RegExp(`<(?:input|button)[^>]*${attribute}[^>]*>`));
  assert.notEqual(match, null, `no control carries ${attribute}`);
  return match![0];
}

test("read-only mode disables the picker inputs", () => {
  const html = renderPicker({}, false);

  assert.match(controlTag(html, 'aria-label="Filter repositories"'), /disabled=""/);
  assert.match(
    controlTag(html, 'aria-label="Pin Blazity/ai-workflow"'),
    /disabled=""/,
  );
});
