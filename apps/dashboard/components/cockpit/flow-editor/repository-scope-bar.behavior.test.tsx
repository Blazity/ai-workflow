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
import { Listbox } from "@/components/cockpit/listbox";
import {
  MAX_PINNED_REPOSITORIES,
  type PinnedRepository,
} from "@/lib/workflow-editor/repository-scope";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function gh(repoPath: string, defaultBranch = "main", archived = false): RepositoryOption {
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
    (node) => typeof node.type === "string" && node.props["aria-label"] === label,
  );
  assert.equal(matches.length, 1, `expected exactly one element labelled ${label}`);
  return matches[0];
}

function hasAriaLabel(root: ReactTestInstance, label: string): boolean {
  return root.findAll(
    (node) => typeof node.type === "string" && node.props["aria-label"] === label,
  ).length > 0;
}

function buttonWithText(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = root
    .findAll((node) => node.type === "button")
    .filter((node) => nodeText(node).includes(text));
  assert.equal(matches.length, 1, `expected exactly one button containing ${text}`);
  return matches[0];
}

interface PickerConfig {
  scope?: WorkflowRepositoryScope;
  canEdit?: boolean;
  status?: RepositoryCatalogStatus;
  repositories?: RepositoryOption[];
}

async function mountPicker(config: PickerConfig = {}) {
  const {
    scope = {},
    canEdit = true,
    status = "ready" as RepositoryCatalogStatus,
    repositories = CATALOG,
  } = config;
  const added: PinnedRepository[][] = [];
  const closes: number[] = [];
  const element = (open: boolean) => (
    <RepositoryCatalogProvider initial={{ status, repositories }}>
      <RepositoryScopePicker
        open={open}
        scope={scope}
        canEdit={canEdit}
        onAdd={(repos) => added.push(repos)}
        onClose={() => closes.push(1)}
      />
    </RepositoryCatalogProvider>
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element(true));
  });
  const root = () => renderer.root;
  return {
    renderer,
    added,
    closes,
    setOpen: async (open: boolean) => {
      await act(async () => renderer.update(element(open)));
    },
    setFilter: async (value: string) => {
      const input = byAriaLabel(root(), "Filter repositories");
      await act(async () => input.props.onChange({ target: { value } }));
    },
    toggle: async (repoPath: string, checked: boolean) => {
      const box = byAriaLabel(root(), `Pin ${repoPath}`);
      await act(async () => box.props.onChange({ target: { checked } }));
    },
    checkboxDisabled: (repoPath: string) =>
      byAriaLabel(root(), `Pin ${repoPath}`).props.disabled === true,
    typeManualPath: async (value: string) => {
      const input = byAriaLabel(root(), "Repository path");
      await act(async () => input.props.onChange({ target: { value } }));
    },
    chooseManualProvider: async (provider: string) => {
      const listbox = root().findByType(Listbox);
      await act(async () => listbox.props.onChange(provider));
    },
    clickManualAdd: async () => {
      await act(async () => buttonWithText(root(), "Add").props.onClick());
    },
    commit: async () => {
      await act(async () => buttonWithText(root(), "Add").props.onClick());
    },
    close: async () => {
      await act(async () =>
        byAriaLabel(root(), "Close the repository picker").props.onClick(),
      );
    },
    addLabel: () => nodeText(buttonWithText(root(), "Add")),
    addDisabled: () => buttonWithText(root(), "Add").props.disabled === true,
    manualOffered: () => hasAriaLabel(root(), "Repository path"),
  };
}

async function mountBar(config: PickerConfig = {}) {
  const {
    scope = {},
    canEdit = true,
    status = "ready" as RepositoryCatalogStatus,
    repositories = CATALOG,
  } = config;
  let current: WorkflowRepositoryScope = scope;
  const changes: WorkflowRepositoryScope[] = [];
  const element = () => (
    <RepositoryCatalogProvider initial={{ status, repositories }}>
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
  /** Feed the new scope back in, the way the editor re-renders on a change. */
  const rerender = async () => {
    await act(async () => renderer.update(element()));
  };
  return {
    renderer,
    changes,
    scope: () => current,
    rerender,
    removeChip: async (repoPath: string) => {
      await act(async () =>
        byAriaLabel(root(), `Remove ${repoPath}`).props.onClick(),
      );
      await rerender();
    },
    toggleProvider: async (label: string) => {
      await act(async () => buttonWithText(root(), label).props.onClick());
      await rerender();
    },
    openPicker: async () => {
      await act(async () =>
        buttonWithText(root(), "+ Add repository").props.onClick(),
      );
    },
    text: () => nodeText(root().findAll((node) => node.type === "div")[0]),
  };
}

test("a selection made under one filter survives a later filter", async () => {
  const picker = await mountPicker();

  await picker.setFilter("prod");
  await picker.toggle("Blazity/ai-workflow-prod", true);
  await picker.setFilter("billing");
  await picker.toggle("acme-group/platform/billing-core", true);

  assert.equal(picker.addLabel(), "Add 2 repositories");
  await picker.commit();

  assert.deepEqual(picker.added, [
    [
      { provider: "github", repoPath: "Blazity/ai-workflow-prod" },
      { provider: "gitlab", repoPath: "acme-group/platform/billing-core" },
    ],
  ]);
  assert.equal(picker.closes.length, 1);
  await act(async () => picker.renderer.unmount());
});

test("an enabled add button never silently does nothing", async () => {
  const picker = await mountPicker();

  await picker.setFilter("prod");
  await picker.toggle("Blazity/ai-workflow-prod", true);
  await picker.setFilter("nothing-matches-this");

  assert.equal(picker.addLabel(), "Add 1 repository");
  assert.equal(picker.addDisabled(), false);
  await picker.commit();

  assert.deepEqual(picker.added, [
    [{ provider: "github", repoPath: "Blazity/ai-workflow-prod" }],
  ]);
  await act(async () => picker.renderer.unmount());
});

test("unchecking a row before committing drops it from the addition", async () => {
  const picker = await mountPicker();

  await picker.toggle("Blazity/ai-workflow-prod", true);
  await picker.toggle("Blazity/ai-workflow-demo", true);
  await picker.toggle("Blazity/ai-workflow-prod", false);
  await picker.commit();

  assert.deepEqual(picker.added, [
    [{ provider: "github", repoPath: "Blazity/ai-workflow-demo" }],
  ]);
  await act(async () => picker.renderer.unmount());
});

test("dismissing the picker discards an uncommitted selection", async () => {
  const picker = await mountPicker();

  await picker.setFilter("prod");
  await picker.toggle("Blazity/ai-workflow-prod", true);
  assert.equal(picker.addLabel(), "Add 1 repository");

  await picker.close();
  await picker.setOpen(false);
  await picker.setOpen(true);

  assert.equal(picker.addLabel(), "Add repositories");
  assert.equal(picker.addDisabled(), true);
  assert.equal(
    byAriaLabel(picker.renderer.root, "Filter repositories").props.value,
    "",
  );
  assert.deepEqual(picker.added, []);
  await act(async () => picker.renderer.unmount());
});

test("the picker refuses to select past the remaining slots", async () => {
  const pinned = Array.from(
    { length: MAX_PINNED_REPOSITORIES - 1 },
    (_value, index) => ({
      provider: "github" as const,
      repoPath: `Blazity/filler-${index}`,
    }),
  );
  const picker = await mountPicker({ scope: { repositories: pinned } });

  await picker.toggle("Blazity/ai-workflow-prod", true);

  assert.equal(picker.checkboxDisabled("Blazity/ai-workflow-demo"), true);
  await picker.commit();

  assert.deepEqual(picker.added, [
    [{ provider: "github", repoPath: "Blazity/ai-workflow-prod" }],
  ]);
  await act(async () => picker.renderer.unmount());
});

test("manual entry pins the exact trimmed path for the chosen provider", async () => {
  const picker = await mountPicker({ status: "error", repositories: [] });

  await picker.chooseManualProvider("gitlab");
  await picker.typeManualPath("  acme-group/platform/billing-core  ");
  await picker.clickManualAdd();

  assert.deepEqual(picker.added, [
    [{ provider: "gitlab", repoPath: "acme-group/platform/billing-core" }],
  ]);
  assert.equal(picker.closes.length, 1);
  await act(async () => picker.renderer.unmount());
});

test("manual entry refuses a blank path and an already-pinned repository", async () => {
  const picker = await mountPicker({
    status: "error",
    repositories: [],
    scope: { repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow-prod" }] },
  });

  await picker.typeManualPath("   ");
  await picker.clickManualAdd();
  assert.deepEqual(picker.added, []);

  await picker.typeManualPath("blazity/AI-WORKFLOW-PROD");
  await picker.clickManualAdd();
  assert.deepEqual(picker.added, []);

  await act(async () => picker.renderer.unmount());
});

test("an empty but healthy catalog still offers manual entry", async () => {
  const picker = await mountPicker({ status: "ready", repositories: [] });

  assert.equal(picker.manualOffered(), true);
  await picker.typeManualPath("Blazity/ai-workflow-prod");
  await picker.clickManualAdd();

  assert.deepEqual(picker.added, [
    [{ provider: "github", repoPath: "Blazity/ai-workflow-prod" }],
  ]);
  await act(async () => picker.renderer.unmount());
});

test("removing a chip hands back a scope without that repository", async () => {
  const bar = await mountBar({
    scope: {
      repositories: [
        { provider: "github", repoPath: "Blazity/ai-workflow-prod" },
        { provider: "gitlab", repoPath: "acme-group/platform/billing-core" },
      ],
    },
  });

  await bar.removeChip("Blazity/ai-workflow-prod");

  assert.deepEqual(bar.scope(), {
    repositories: [
      { provider: "gitlab", repoPath: "acme-group/platform/billing-core" },
    ],
  });

  await bar.removeChip("acme-group/platform/billing-core");
  assert.deepEqual(bar.scope(), {});
  await act(async () => bar.renderer.unmount());
});

test("toggling a provider pill pins it and toggling again clears the key", async () => {
  const bar = await mountBar();

  await bar.toggleProvider("GitHub");
  assert.deepEqual(bar.scope(), { providers: ["github"] });

  await bar.toggleProvider("GitLab");
  assert.deepEqual(bar.scope(), { providers: ["github", "gitlab"] });

  await bar.toggleProvider("GitHub");
  assert.deepEqual(bar.scope(), { providers: ["gitlab"] });

  await bar.toggleProvider("GitLab");
  assert.deepEqual(bar.scope(), {});
  await act(async () => bar.renderer.unmount());
});

test("a provider pin that excludes a pinned repository is named, not asserted", async () => {
  const bar = await mountBar({
    scope: {
      repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow-prod" }],
      providers: ["gitlab"],
    },
  });

  const shown = bar.text();
  assert.match(shown, /Provider mismatch/);
  assert.match(shown, /Blazity\/ai-workflow-prod \(GitHub\)/);
  assert.match(shown, /Deployment rejects this until the two agree/);
  assert.match(shown, /inherits 1 repo, provider mismatch/);
  assert.doesNotMatch(shown, /inherits 1 repo, GitLab/);
  await act(async () => bar.renderer.unmount());
});

test("adding the excluded provider clears the mismatch", async () => {
  const bar = await mountBar({
    scope: {
      repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow-prod" }],
      providers: ["gitlab"],
    },
  });

  await bar.toggleProvider("GitHub");

  assert.deepEqual(bar.scope(), {
    repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow-prod" }],
    providers: ["github", "gitlab"],
  });
  assert.doesNotMatch(bar.text(), /Provider mismatch/);
  assert.match(bar.text(), /inherits 1 repo, GitHub \+ GitLab/);
  await act(async () => bar.renderer.unmount());
});

test("the picker adds through the bar and lands in the scope", async () => {
  const bar = await mountBar();

  await bar.openPicker();
  const box = byAriaLabel(bar.renderer.root, "Pin Blazity/ai-workflow-prod");
  await act(async () => box.props.onChange({ target: { checked: true } }));
  await act(async () =>
    buttonWithText(bar.renderer.root, "Add 1 repository").props.onClick(),
  );

  assert.deepEqual(bar.scope(), {
    repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow-prod" }],
  });
  await act(async () => bar.renderer.unmount());
});

test("a read-only bar wires no handler at all", async () => {
  const bar = await mountBar({
    scope: {
      repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow-prod" }],
      providers: ["github"],
    },
    canEdit: false,
  });

  const remove = byAriaLabel(bar.renderer.root, "Remove Blazity/ai-workflow-prod");
  const provider = buttonWithText(bar.renderer.root, "GitHub");
  const add = buttonWithText(bar.renderer.root, "+ Add repository");

  assert.equal(remove.props.disabled, true);
  assert.equal(provider.props.disabled, true);
  assert.equal(add.props.disabled, true);
  assert.deepEqual(bar.changes, []);
  await act(async () => bar.renderer.unmount());
});
