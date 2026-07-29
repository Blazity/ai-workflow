import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";

import type {
  RepositoryOption,
  RepositoryProviderStatus,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import { Listbox } from "@/components/cockpit/listbox";
import { MAX_PINNED_REPOSITORIES } from "@/lib/workflow-editor/repository-scope";
import {
  RepositoryCatalogProvider,
  type RepositoryCatalogStatus,
} from "./repository-catalog-context";
import { RepositoryScopeBar } from "./repository-scope-bar";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function gh(
  repoPath: string,
  defaultBranch = "main",
  archived = false,
): RepositoryOption {
  const [owner, ...rest] = repoPath.split("/");
  return {
    provider: "github",
    repoPath,
    name: rest.join("/"),
    owner,
    defaultBranch,
    private: true,
    archived,
  };
}

function gl(repoPath: string, defaultBranch = "main"): RepositoryOption {
  const segments = repoPath.split("/");
  return {
    provider: "gitlab",
    repoPath,
    name: segments[segments.length - 1],
    owner: segments.slice(0, -1).join("/"),
    defaultBranch,
    private: true,
    archived: false,
  };
}

const CATALOG: RepositoryOption[] = [
  gh("Blazity/ai-workflow-prod"),
  gh("Blazity/ai-workflow-demo"),
  gh("Blazity/next-enterprise"),
  gh("Blazity/legacy-portal", "master", true),
  gl("filipmaszota3/ai-workflow-integration-test"),
  gl("acme-group/platform/billing-core", "develop"),
];

function nodeText(node: ReactTestInstance): string {
  return node.children
    .flatMap((child) => (typeof child === "string" ? [child] : [nodeText(child)]))
    .join("");
}

function byAriaLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      typeof node.type === "string" && node.props["aria-label"] === label,
  );
  assert.equal(matches.length, 1, `expected exactly one element labelled ${label}`);
  return matches[0];
}

function buttonWithText(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = root
    .findAll((node) => node.type === "button")
    .filter((node) => nodeText(node).includes(text));
  assert.equal(matches.length, 1, `expected exactly one button containing ${text}`);
  return matches[0];
}

interface BarConfig {
  scope?: WorkflowRepositoryScope;
  canEdit?: boolean;
  status?: RepositoryCatalogStatus;
  repositories?: RepositoryOption[];
  providers?: RepositoryProviderStatus[];
}

async function mountBar(config: BarConfig = {}) {
  const {
    scope = {},
    canEdit = true,
    status = "ready" as RepositoryCatalogStatus,
    repositories = CATALOG,
    providers = [
      { provider: "github", status: "ready" },
      { provider: "gitlab", status: "ready" },
    ],
  } = config;
  let current: WorkflowRepositoryScope = scope;
  const changes: WorkflowRepositoryScope[] = [];
  const element = () => (
    <RepositoryCatalogProvider initial={{ status, repositories, providers }}>
      <RepositoryScopeBar
        scope={current}
        canEdit={canEdit}
        onChange={(next) => {
          current = next;
          changes.push(next);
        }}
      />
    </RepositoryCatalogProvider>
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element());
  });
  const root = () => renderer.root;
  return {
    renderer,
    changes,
    scope: () => current,
    rerender: async () => {
      await act(async () => renderer.update(element()));
    },
    open: async () => {
      await act(async () =>
        buttonWithText(root(), "Configure").props.onClick(),
      );
    },
    toggleProvider: async (provider: string) => {
      await act(async () =>
        buttonWithText(root(), provider).props.onClick(),
      );
    },
    setFilter: async (value: string) => {
      await act(async () =>
        byAriaLabel(root(), "Filter repositories").props.onChange({
          target: { value },
        }),
      );
    },
    toggleRepository: async (repoPath: string, checked: boolean) => {
      await act(async () =>
        byAriaLabel(root(), `Pin ${repoPath}`).props.onChange({
          target: { checked },
        }),
      );
    },
    removeRepository: async (repoPath: string) => {
      await act(async () =>
        byAriaLabel(root(), `Remove ${repoPath}`).props.onClick(),
      );
    },
    cancel: async () => {
      await act(async () => buttonWithText(root(), "Cancel").props.onClick());
    },
    apply: async () => {
      await act(async () =>
        buttonWithText(root(), "Apply scope").props.onClick(),
      );
      await act(async () => renderer.update(element()));
    },
    text: () => nodeText(root()),
  };
}

test("the compact bar opens a dialog without changing the scope", async () => {
  const bar = await mountBar();
  const configure = buttonWithText(bar.renderer.root, "Configure");

  assert.equal(configure.props["aria-haspopup"], "dialog");
  assert.equal(
    bar.renderer.root.findAll((node) => node.props.role === "dialog").length,
    0,
  );
  await bar.open();
  assert.equal(
    bar.renderer.root.findAll((node) => node.props.role === "dialog").length,
    1,
  );
  assert.deepEqual(bar.changes, []);
  await act(async () => bar.renderer.unmount());
});

test("provider edits stay in the modal draft until Apply scope", async () => {
  const bar = await mountBar();

  await bar.open();
  await bar.toggleProvider("GitHub");
  await bar.cancel();
  assert.deepEqual(bar.changes, []);

  await bar.open();
  await bar.toggleProvider("GitHub");
  await bar.apply();
  assert.deepEqual(bar.changes, [{ providers: ["gitlab"] }]);
  await act(async () => bar.renderer.unmount());
});

test("all connected providers are active by default", async () => {
  const bar = await mountBar();

  await bar.open();
  assert.equal(buttonWithText(bar.renderer.root, "GitHub").props["aria-pressed"], true);
  assert.equal(buttonWithText(bar.renderer.root, "GitLab").props["aria-pressed"], true);
  await act(async () => bar.renderer.unmount());
});

test("deactivating a provider hides its repositories and removes its draft pins", async () => {
  const bar = await mountBar({
    scope: {
      repositories: [
        { provider: "github", repoPath: "Blazity/ai-workflow-prod" },
        {
          provider: "gitlab",
          repoPath: "acme-group/platform/billing-core",
        },
      ],
    },
  });

  await bar.open();
  await bar.toggleProvider("GitHub");
  assert.equal(
    bar.renderer.root.findAll(
      (node) => node.props["aria-label"] === "Pin Blazity/ai-workflow-demo",
    ).length,
    0,
  );
  assert.equal(
    bar.renderer.root.findAll(
      (node) => node.props["aria-label"] === "Remove Blazity/ai-workflow-prod",
    ).length,
    0,
  );
  await bar.apply();
  assert.deepEqual(bar.changes, [
    {
      repositories: [
        {
          provider: "gitlab",
          repoPath: "acme-group/platform/billing-core",
        },
      ],
      providers: ["gitlab"],
    },
  ]);
  await act(async () => bar.renderer.unmount());
});

test("the last active provider cannot be deactivated", async () => {
  const bar = await mountBar();

  await bar.open();
  await bar.toggleProvider("GitHub");
  assert.equal(buttonWithText(bar.renderer.root, "GitLab").props.disabled, true);
  await bar.apply();
  assert.deepEqual(bar.changes, [{ providers: ["gitlab"] }]);
  await act(async () => bar.renderer.unmount());
});

test("a provider without configuration is disabled and labelled Not connected", async () => {
  const bar = await mountBar({
    repositories: CATALOG.filter((repository) => repository.provider === "github"),
    providers: [
      { provider: "github", status: "ready" },
      { provider: "gitlab", status: "not_connected" },
    ],
  });

  await bar.open();
  const gitLab = buttonWithText(bar.renderer.root, "GitLab");
  assert.equal(gitLab.props.disabled, true);
  assert.equal(gitLab.props["aria-pressed"], false);
  assert.match(nodeText(gitLab), /Not connected/);
  assert.equal(buttonWithText(bar.renderer.root, "GitHub").props["aria-pressed"], true);
  await act(async () => bar.renderer.unmount());
});

test("repository choices across filters apply as one scope change", async () => {
  const bar = await mountBar();

  await bar.open();
  await bar.setFilter("prod");
  await bar.toggleRepository("Blazity/ai-workflow-prod", true);
  await bar.setFilter("billing");
  await bar.toggleRepository("acme-group/platform/billing-core", true);
  assert.deepEqual(bar.changes, []);
  await bar.apply();

  assert.deepEqual(bar.changes, [
    {
      repositories: [
        { provider: "github", repoPath: "Blazity/ai-workflow-prod" },
        {
          provider: "gitlab",
          repoPath: "acme-group/platform/billing-core",
        },
      ],
    },
  ]);
  await act(async () => bar.renderer.unmount());
});

test("catalog checkboxes and selected chips both remove from the draft", async () => {
  const bar = await mountBar({
    scope: {
      repositories: [
        { provider: "github", repoPath: "Blazity/ai-workflow-prod" },
        {
          provider: "gitlab",
          repoPath: "acme-group/platform/billing-core",
        },
      ],
    },
  });

  await bar.open();
  await bar.toggleRepository("Blazity/ai-workflow-prod", false);
  await bar.removeRepository("acme-group/platform/billing-core");
  assert.deepEqual(bar.changes, []);
  await bar.apply();
  assert.deepEqual(bar.changes, [{}]);
  await act(async () => bar.renderer.unmount());
});

test("the modal prevents selecting more than the repository limit", async () => {
  const repositories = Array.from(
    { length: MAX_PINNED_REPOSITORIES - 1 },
    (_value, index) => ({
      provider: "github" as const,
      repoPath: `Blazity/filler-${index}`,
    }),
  );
  const bar = await mountBar({ scope: { repositories } });

  await bar.open();
  await bar.toggleRepository("Blazity/ai-workflow-prod", true);
  assert.equal(
    byAriaLabel(
      bar.renderer.root,
      "Pin Blazity/ai-workflow-demo",
    ).props.disabled,
    true,
  );
  assert.match(bar.text(), new RegExp(`0 of ${MAX_PINNED_REPOSITORIES} slots left`));
  await act(async () => bar.renderer.unmount());
});

test("manual fallback updates only the draft with a trimmed exact path", async () => {
  const bar = await mountBar({ status: "error", repositories: [] });

  await bar.open();
  const listbox = bar.renderer.root.findByType(Listbox);
  await act(async () => listbox.props.onChange("gitlab"));
  await act(async () =>
    byAriaLabel(bar.renderer.root, "Repository path").props.onChange({
      target: { value: "  acme-group/platform/billing-core  " },
    }),
  );
  await act(async () =>
    buttonWithText(bar.renderer.root, "Add to selection").props.onClick(),
  );
  assert.deepEqual(bar.changes, []);
  await bar.apply();

  assert.deepEqual(bar.changes, [
    {
      repositories: [
        {
          provider: "gitlab",
          repoPath: "acme-group/platform/billing-core",
        },
      ],
    },
  ]);
  await act(async () => bar.renderer.unmount());
});

test("provider mismatches are detailed in the modal and clear in its draft", async () => {
  const bar = await mountBar({
    scope: {
      repositories: [
        { provider: "github", repoPath: "Blazity/ai-workflow-prod" },
      ],
      providers: ["gitlab"],
    },
  });

  assert.match(bar.text(), /Needs attention/);
  assert.doesNotMatch(bar.text(), /Provider mismatch/);
  await bar.open();
  assert.match(bar.text(), /Provider mismatch/);
  assert.match(bar.text(), /Blazity\/ai-workflow-prod \(GitHub\)/);
  await bar.toggleProvider("GitHub");
  assert.doesNotMatch(bar.text(), /Provider mismatch/);
  await bar.apply();

  assert.deepEqual(bar.scope(), {
    repositories: [
      { provider: "github", repoPath: "Blazity/ai-workflow-prod" },
    ],
  });
  await act(async () => bar.renderer.unmount());
});

test("read-only mode cannot open the modal", async () => {
  const bar = await mountBar({ canEdit: false });
  const configure = buttonWithText(bar.renderer.root, "Configure");

  assert.equal(configure.props.disabled, true);
  assert.equal(configure.props.onClick === undefined, false);
  assert.deepEqual(bar.changes, []);
  await act(async () => bar.renderer.unmount());
});

test("Escape and backdrop dismissal discard the modal draft", async () => {
  const bar = await mountBar();

  await bar.open();
  await bar.toggleProvider("GitHub");
  const backdrop = bar.renderer.root.find(
    (node) =>
      node.type === "div" &&
      typeof node.props.className === "string" &&
      node.props.className.includes("fixed inset-0"),
  );
  await act(async () =>
    backdrop.props.onKeyDown({ key: "Escape", preventDefault: () => undefined }),
  );
  assert.deepEqual(bar.changes, []);
  assert.equal(
    bar.renderer.root.findAll((node) => node.props.role === "dialog").length,
    0,
  );

  await bar.open();
  await bar.toggleProvider("GitHub");
  const reopenedBackdrop = bar.renderer.root.find(
    (node) =>
      node.type === "div" &&
      typeof node.props.className === "string" &&
      node.props.className.includes("fixed inset-0"),
  );
  await act(async () =>
    reopenedBackdrop.props.onMouseDown({
      target: reopenedBackdrop,
      currentTarget: reopenedBackdrop,
    }),
  );
  assert.deepEqual(bar.changes, []);
  assert.equal(
    bar.renderer.root.findAll((node) => node.props.role === "dialog").length,
    0,
  );
  await act(async () => bar.renderer.unmount());
});

test("Tab wraps from the last modal control to the first", async () => {
  const bar = await mountBar();
  await bar.open();
  const backdrop = bar.renderer.root.find(
    (node) =>
      node.type === "div" &&
      typeof node.props.className === "string" &&
      node.props.className.includes("fixed inset-0"),
  );
  let firstFocuses = 0;
  let prevented = 0;
  const first = { focus: () => firstFocuses++ };
  const last = { focus: () => undefined };

  await act(async () =>
    backdrop.props.onKeyDown({
      key: "Tab",
      shiftKey: false,
      target: last,
      currentTarget: {
        querySelectorAll: () => [first, last],
      },
      preventDefault: () => prevented++,
    }),
  );

  assert.equal(prevented, 1);
  assert.equal(firstFocuses, 1);
  await act(async () => bar.renderer.unmount());
});

test("catalog refresh drops a newly selected repository that disappears", async () => {
  const originalFetch = globalThis.fetch;
  const queue = [
    [gh("Blazity/ai-workflow-prod"), gh("Blazity/ai-workflow-demo")],
    [gh("Blazity/ai-workflow-demo")],
  ];
  globalThis.fetch = (() => {
    const repositories = queue.shift();
    assert.notEqual(repositories, undefined);
    return Promise.resolve(
      Response.json({
        repositories,
        providers: [
          { provider: "github", status: "ready" },
          { provider: "gitlab", status: "not_connected" },
        ],
      }),
    );
  }) as typeof globalThis.fetch;

  let current: WorkflowRepositoryScope = {};
  const changes: WorkflowRepositoryScope[] = [];
  const element = () => (
    <RepositoryCatalogProvider>
      <RepositoryScopeBar
        scope={current}
        canEdit
        onChange={(next) => {
          current = next;
          changes.push(next);
        }}
      />
    </RepositoryCatalogProvider>
  );
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(element());
    });
    await act(async () => undefined);
    await act(async () =>
      buttonWithText(renderer.root, "Configure").props.onClick(),
    );
    await act(async () =>
      byAriaLabel(
        renderer.root,
        "Pin Blazity/ai-workflow-prod",
      ).props.onChange({ target: { checked: true } }),
    );
    await act(async () =>
      buttonWithText(renderer.root, "Refresh catalog").props.onClick(),
    );
    await act(async () => undefined);

    assert.equal(
      renderer.root.findAll(
        (node) =>
          typeof node.type === "string" &&
          node.props["aria-label"] === "Remove Blazity/ai-workflow-prod",
      ).length,
      0,
    );
    await act(async () =>
      buttonWithText(renderer.root, "Apply scope").props.onClick(),
    );
    assert.deepEqual(changes, [{}]);
  } finally {
    if (renderer!) {
      await act(async () => renderer.unmount());
    }
    globalThis.fetch = originalFetch;
  }
});
