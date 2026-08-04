import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  RepositoryOption,
  WorkflowEditorOptions,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import type { FlowNodeDef, WorkflowBlockType } from "@/lib/flows";
import { ConfigFields } from "./config-fields";
import { RepositoryCatalogProvider } from "./repository-catalog-context";
import { RepositoryScopeProvider } from "./repository-scope-context";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const PR_TRIGGERS: WorkflowBlockType[] = [
  "trigger_pr_created",
  "trigger_pr_ready",
  "trigger_pr_updated",
  "trigger_pr_checks_failed",
  "trigger_pr_review",
  "trigger_pr_merged",
];

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

function node(type: WorkflowBlockType, scope: "any" | "workflow_owned"): FlowNodeDef {
  return {
    id: type,
    type,
    name: type,
    x: 0,
    y: 0,
    params: { scope, checkNames: ["ci / build"] },
    inputs: {},
  };
}

function render(
  nodeDefinition: FlowNodeDef,
  scope: WorkflowRepositoryScope = {},
  canEdit = true,
): string {
  return renderToStaticMarkup(
    <RepositoryCatalogProvider initial={{ status: "ready", repositories: catalog }}>
      <RepositoryScopeProvider scope={scope} onChange={() => undefined}>
        <ConfigFields
          node={nodeDefinition}
          options={options}
          canEdit={canEdit}
          onChange={() => undefined}
        />
      </RepositoryScopeProvider>
    </RepositoryCatalogProvider>,
  );
}

test("every pull request trigger panel summarises the pinned repositories", () => {
  for (const type of PR_TRIGGERS) {
    const html = render(node(type, "any"), {
      repositories: [{ provider: "github", repoPath: "Blazity/ai-workflow" }],
      providers: ["github"],
    });

    assert.match(html, />Repositories</, type);
    assert.match(html, /1 repo, GitHub/, type);
    assert.match(html, /aria-haspopup="dialog"[^>]*>Configure repositories</, type);
  }
});

test("an unpinned workflow reads as automatic rather than as an empty list", () => {
  const html = render(node("trigger_pr_created", "any"));

  assert.match(html, /Automatic per ticket/);
  assert.doesNotMatch(html, /role="dialog"/);
});

test("workflow-owned scope explains that ownership, not the list, admits the event", () => {
  const owned = render(node("trigger_pr_review", "workflow_owned"));
  assert.match(owned, /narrows which repositories the workflow may work in/);
  assert.match(owned, /only pull requests AI Workflow opened reach this trigger/);

  const any = render(node("trigger_pr_review", "any"));
  assert.doesNotMatch(any, /narrows which repositories the workflow may work in/);
});

test("a read-only inspector cannot open the repository modal", () => {
  const html = render(node("trigger_pr_merged", "any"), {}, false);

  assert.match(html, /aria-haspopup="dialog" disabled=""[^>]*>Configure repositories</);
});

// ConfigFields renders outside the provider in other suites, so the field has to
// stay inert there rather than crash the whole inspector.
test("the field disappears when no repository scope provider is mounted", () => {
  const html = renderToStaticMarkup(
    <RepositoryCatalogProvider initial={{ status: "ready", repositories: catalog }}>
      <ConfigFields
        node={node("trigger_pr_created", "any")}
        options={options}
        canEdit
        onChange={() => undefined}
      />
    </RepositoryCatalogProvider>,
  );

  assert.doesNotMatch(html, /Configure repositories/);
  assert.match(html, />Providers</);
});
