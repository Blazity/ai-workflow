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
  type RepositoryPickerOption,
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

/** Markup with every tag dropped, so an assertion can target what an operator
 *  actually reads rather than what an attribute carries for assistive tech. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
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

test("an unpinned workflow renders connected providers and automatic repository selection", () => {
  const html = renderBar({});

  assert.match(html, /Source scope/);
  assert.match(html, /Providers &amp; repositories/);
  assert.match(html, /GitHub \+ GitLab/);
  assert.match(html, /Automatic per ticket/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, />Configure</);
  assert.doesNotMatch(html, /Add repositories/);
  assert.doesNotMatch(html, /role="dialog"/);
});

test("the compact summary presents explicit scope as non-interactive text", () => {
  const html = renderBar({
    repositories: [
      { provider: "github", repoPath: "Blazity/ai-workflow" },
      { provider: "gitlab", repoPath: "group/app" },
    ],
    providers: ["github", "gitlab"],
  });

  assert.match(html, /Providers:/);
  assert.match(html, /GitHub \+ GitLab/);
  assert.match(html, /Repositories:/);
  assert.match(html, /2 pinned/);
  assert.doesNotMatch(html, /border-mariner\/30 bg-mariner-100/);
  assert.match(html, /tabular-nums/);
});

test("the compact summary names attention without expanding detailed warnings", () => {
  const html = renderBar({
    repositories: [{ provider: "github", repoPath: "Blazity/private-thing" }],
  });

  assert.match(html, /role="status"/);
  assert.match(html, />Needs attention</);
  // Original invariant, unchanged: the bar must not grow into a warning panel
  // that duplicates the modal's prose.
  assert.doesNotMatch(visibleText(html), /Blazity\/private-thing/);
  assert.doesNotMatch(html, /The catalog does not list/);
  // Loosened deliberately: the offender moved from "not rendered at all" to
  // "rendered in the badge's accessible name only".
  assert.match(html, /title="Blazity\/private-thing: not in catalog"/);
});

test("the attention label names every offending pin and its reason", () => {
  const html = renderBar(
    {
      repositories: [
        { provider: "gitlab", repoPath: "group/app" },
        { provider: "github", repoPath: "Blazity/private-thing" },
        { provider: "github", repoPath: "Blazity/legacy" },
      ],
    },
    true,
    "ready",
    catalog.filter((repository) => repository.provider === "github"),
  );

  const label = html.match(/aria-label="Needs attention: ([^"]*)"/);
  assert.ok(label);
  assert.equal(
    label[1],
    "group/app: provider not connected; Blazity/private-thing: not in catalog; Blazity/legacy: archived",
  );
});

test("a pin its own provider list excludes is named as a contradiction", () => {
  const html = renderBar({
    repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow" }],
    providers: ["gitlab"],
  });

  assert.match(
    html,
    /aria-label="Needs attention: Blazity\/ai-workflow: excluded by the pinned providers"/,
  );
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
  assert.match(html, /Repositories:<\/span> 1 pinned/);
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

// ── The repository catalog decides what may be pinned ────────────────────────

/** The modal over a catalog whose activation and per-row enablement matter,
 *  which the positional helper above cannot express. */
function renderCatalogModal(input: {
  scope: WorkflowRepositoryScope;
  repositories: RepositoryPickerOption[];
  activated: boolean;
}): string {
  return renderToStaticMarkup(
    <RepositoryCatalogProvider
      initial={{
        status: "ready",
        repositories: input.repositories,
        activated: input.activated,
        providers: [
          { provider: "github", status: "ready" },
          { provider: "gitlab", status: "ready" },
        ],
      }}
    >
      <RepositoryScopeModal
        open
        scope={input.scope}
        canEdit
        onApply={() => undefined}
        onCancel={() => undefined}
      />
    </RepositoryCatalogProvider>,
  );
}

test("a repository the catalog does not enable is offered AND pinnable while the bridge is on", () => {
  // Marked rather than hidden, and pinnable rather than refused: dispatch
  // accepts it today, so refusing the pin would be the picker inventing a rule
  // the worker does not have. The label says what changes on activation day.
  const html = renderCatalogModal({
    scope: {},
    activated: false,
    repositories: [
      { ...option(), enabledInCatalog: true },
      { ...option({ repoPath: "Blazity/unlisted", name: "unlisted" }), enabledInCatalog: false },
    ],
  });

  assert.match(html, /Blazity\/unlisted/);
  assert.doesNotMatch(html, /disabled=""[^>]*aria-label="Pin Blazity\/unlisted"/);
  assert.match(
    visibleText(html),
    /Not enabled in the catalog: refused once the catalog is activated/,
  );
  assert.match(
    visibleText(html),
    /can be pinned and work today\. They stop the day somebody activates the catalog/,
  );
  // The enabled row beside it is untouched.
  assert.doesNotMatch(html, /disabled=""[^>]*aria-label="Pin Blazity\/ai-workflow"/);
});

test("an already-pinned row the catalog refuses still says so, and can still be unticked", () => {
  // The one row an operator needs to see used to render as an ordinary healthy
  // row, because the label was suppressed for anything already selected.
  const html = renderCatalogModal({
    scope: { repositories: [{ provider: "github", repoPath: "Blazity/unlisted" }] },
    activated: true,
    repositories: [
      { ...option(), enabledInCatalog: true },
      { ...option({ repoPath: "Blazity/unlisted", name: "unlisted" }), enabledInCatalog: false },
    ],
  });

  assert.match(visibleText(html), /Not enabled in the repository catalog/);
  // Unticking a pin the catalog refuses is exactly the repair to leave open.
  assert.doesNotMatch(html, /disabled=""[^>]*aria-label="Pin Blazity\/unlisted"/);
});

test("a pin the catalog does not enable is named without claiming a refusal that has not happened", () => {
  // Under the bridge the pin works. The publish's sentence says dispatch refuses
  // the events, which would be false today, so the bridge gets its own wording.
  const html = renderCatalogModal({
    scope: { repositories: [{ provider: "github", repoPath: "Blazity/unlisted" }] },
    activated: false,
    repositories: [
      { ...option(), enabledInCatalog: true },
      { ...option({ repoPath: "Blazity/unlisted", name: "unlisted" }), enabledInCatalog: false },
    ],
  });

  assert.match(
    visibleText(html),
    /It passes today because the catalog is not activated; the day somebody activates it, dispatch starts refusing events from it: github:Blazity\/unlisted\./,
  );
  assert.doesNotMatch(visibleText(html), /so dispatch refuses events from it and/);
});

test("an activated catalog offers no row it does not enable, and names a pin it does not in the publish's own words", () => {
  // The dashboard and workflows.publish describe one fact, so they describe it
  // with one sentence: an operator who reads both must not have to decide which
  // is true.
  const html = renderCatalogModal({
    scope: { repositories: [{ provider: "github", repoPath: "Blazity/unlisted" }] },
    activated: true,
    repositories: [{ ...option(), enabledInCatalog: true }],
  });

  // The sentence is `pinnedRepositoriesNotEnabledSentence` from the contracts
  // now, shared with `workflows.publish` and with the deploy response, so this
  // asserts the shared wording rather than a second copy of it.
  assert.match(
    visibleText(html),
    /It pins a repository the repository catalog does not enable, so dispatch refuses events from it and a run that starts some other way cannot reach it either: github:Blazity\/unlisted\./,
  );
  // Not the bridge's "the catalog does not list" wording, which says nothing
  // about dispatch refusing anything.
  assert.doesNotMatch(visibleText(html), /The catalog does not list/);
  // The pin itself is kept: dropping somebody's saved configuration silently is
  // how an operator loses a repository without being told.
  assert.match(html, /aria-label="Remove Blazity\/unlisted"/);
});

test("the bar's attention badge separates a pin the catalog does not enable from one it cannot see", () => {
  const activated = renderToStaticMarkup(
    <RepositoryCatalogProvider
      initial={{
        status: "ready",
        activated: true,
        repositories: [{ ...option(), enabledInCatalog: true }],
        providers: [{ provider: "github", status: "ready" }],
      }}
    >
      <RepositoryScopeBar
        scope={{ repositories: [{ provider: "github", repoPath: "Blazity/unlisted" }] }}
        canEdit
        onChange={() => undefined}
      />
    </RepositoryCatalogProvider>,
  );

  assert.match(activated, /Blazity\/unlisted: not enabled in the catalog/);
  assert.doesNotMatch(activated, /Blazity\/unlisted: not in catalog/);
});
