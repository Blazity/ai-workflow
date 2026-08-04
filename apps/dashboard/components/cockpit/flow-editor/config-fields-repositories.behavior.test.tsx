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
  WorkflowEditorOptions,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import { ConfigFields } from "./config-fields";
import { RepositoryCatalogProvider } from "./repository-catalog-context";
import { RepositoryScopeProvider } from "./repository-scope-context";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const options = {
  agentKind: "claude",
  defaultModel: "claude-sonnet",
  defaultModels: { claude: "claude-sonnet", codex: "gpt-5" },
  models: { claude: ["claude-sonnet"], codex: ["gpt-5"] },
  ticketStatusTargets: [],
  blockRegistry: {},
} as unknown as WorkflowEditorOptions;

const catalog: RepositoryOption[] = [
  {
    provider: "github",
    repoPath: "Blazity/ai-workflow",
    name: "ai-workflow",
    owner: "Blazity",
    defaultBranch: "main",
    private: true,
    archived: false,
  },
  {
    provider: "github",
    repoPath: "Blazity/next-enterprise",
    name: "next-enterprise",
    owner: "Blazity",
    defaultBranch: "main",
    private: true,
    archived: false,
  },
];

const triggerNode: FlowNodeDef = {
  id: "trigger",
  type: "trigger_pr_created",
  name: "PR created",
  x: 0,
  y: 0,
  params: { scope: "any" },
  inputs: {},
};

function nodeText(instance: ReactTestInstance): string {
  return instance.children
    .flatMap((child) => (typeof child === "string" ? [child] : [nodeText(child)]))
    .join("");
}

function buttonWithText(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = root
    .findAll((instance) => instance.type === "button")
    .filter((instance) => nodeText(instance).includes(text));
  assert.equal(matches.length, 1, `expected exactly one button containing ${text}`);
  return matches[0];
}

function dialogs(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((instance) => instance.props.role === "dialog");
}

// The panel is a view onto the definition-level pin, so applying here has to
// travel the same callback the top bar uses instead of writing trigger params.
test("the trigger panel edits the definition pin through the shared modal", async () => {
  const changes: WorkflowRepositoryScope[] = [];
  let current: WorkflowRepositoryScope = {};
  const element = () => (
    <RepositoryCatalogProvider initial={{ status: "ready", repositories: catalog }}>
      <RepositoryScopeProvider
        scope={current}
        onChange={(next) => {
          current = next;
          changes.push(next);
        }}
      >
        <ConfigFields
          node={triggerNode}
          options={options}
          canEdit
          onChange={() => undefined}
        />
      </RepositoryScopeProvider>
    </RepositoryCatalogProvider>
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element());
  });
  const root = () => renderer.root;

  assert.equal(dialogs(root()).length, 0);
  await act(async () =>
    buttonWithText(root(), "Configure repositories").props.onClick(),
  );
  assert.equal(dialogs(root()).length, 1);

  const pin = root().findAll(
    (instance) =>
      typeof instance.type === "string" &&
      instance.props["aria-label"] === "Pin Blazity/next-enterprise",
  );
  assert.equal(pin.length, 1);
  await act(async () => pin[0].props.onChange({ target: { checked: true } }));
  assert.deepEqual(changes, []);

  await act(async () => buttonWithText(root(), "Apply scope").props.onClick());
  assert.deepEqual(changes, [
    { repositories: [{ provider: "github", repoPath: "Blazity/next-enterprise" }] },
  ]);
  assert.equal(dialogs(root()).length, 0);

  await act(async () => renderer.update(element()));
  assert.match(nodeText(root()), /1 repo, GitHub/);
  await act(async () => renderer.unmount());
});

test("cancelling the panel modal leaves the pin untouched", async () => {
  const changes: WorkflowRepositoryScope[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <RepositoryCatalogProvider initial={{ status: "ready", repositories: catalog }}>
        <RepositoryScopeProvider
          scope={{ repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow" }] }}
          onChange={(next) => changes.push(next)}
        >
          <ConfigFields
            node={triggerNode}
            options={options}
            canEdit
            onChange={() => undefined}
          />
        </RepositoryScopeProvider>
      </RepositoryCatalogProvider>,
    );
  });
  const root = () => renderer.root;

  await act(async () =>
    buttonWithText(root(), "Configure repositories").props.onClick(),
  );
  await act(async () =>
    root()
      .findAll(
        (instance) =>
          typeof instance.type === "string" &&
          instance.props["aria-label"] === "Remove Blazity/ai-workflow",
      )[0]
      .props.onClick(),
  );
  await act(async () => buttonWithText(root(), "Cancel").props.onClick());

  assert.deepEqual(changes, []);
  assert.equal(dialogs(root()).length, 0);
  assert.match(nodeText(root()), /1 repo, GitHub/);
  await act(async () => renderer.unmount());
});
