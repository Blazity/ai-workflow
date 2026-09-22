import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {
  createRoot as createDomRoot,
  type Root as DomRoot,
} from "react-dom/client";
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
import { installTestDom } from "@/components/ui/test-dom";
import { MAX_PINNED_REPOSITORIES } from "@/lib/workflow-editor/repository-scope";
import {
  RepositoryCatalogProvider,
  type RepositoryCatalogStatus,
} from "./repository-catalog-context";
import { RepositoryScopeBar } from "./repository-scope-bar";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
(globalThis as typeof globalThis & { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame = (callback) => {
  callback(0);
  return 1;
};
(globalThis as typeof globalThis & { cancelAnimationFrame: typeof cancelAnimationFrame }).cancelAnimationFrame = () => undefined;

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
    name: segments.at(-1) ?? "",
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

/** What `settle` watches: the reads the bar has out, and how many it has
 *  started, so a turn that started another one is not mistaken for quiet.
 *  One mount per test, and this file's tests run one at a time. */
interface Reads {
  inFlight: number;
  started: number;
}
let reads: Reads = { inFlight: 0, started: 0 };

/**
 * Installs `handler` as the fetch for one test and returns the undo.
 *
 * Every answer lands a turn later, the way a response does: resolving in the
 * caller's own microtask is what let a counted wait look reliable.
 * `FIXTURE_SLOW_MS` delays every answer by that many milliseconds, which is
 * how this harness reproduces a runner slow enough to break a counted wait.
 */
function installFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): () => void {
  const originalFetch = globalThis.fetch;
  // The count belongs to this installation, not to the file: a test may end
  // while an answer is still on its way, and a count the next test had zeroed
  // would go negative when that answer lands, so nothing would ever look quiet
  // again. A leftover answer decrements the count of the test it belongs to,
  // where nobody is watching any more.
  const mine: Reads = { inFlight: 0, started: 0 };
  reads = mine;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    mine.inFlight += 1;
    mine.started += 1;
    const answer = async () => {
      const slow = Number(process.env.FIXTURE_SLOW_MS ?? 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(slow, 0)));
      return handler(String(url), init);
    };
    return answer().finally(() => {
      mine.inFlight -= 1;
    });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/** One turn of what a browser does between two paints: the microtasks a
 *  resolved promise queues, and the macrotask a fetch body lands on. */
async function turn() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Lets the chain of reads the catalog starts finish, and waits for exactly
 * that.
 *
 * NEVER A COUNT OF TURNS. One refresh is two reads whose bodies land a turn or
 * more after the call, and a landed read can start the next one. How many
 * turns that costs is the runner's business, so a fixed count passes on an
 * idle machine and, on a loaded one, returns while a read is still in flight:
 * the assertion then reads a half-loaded bar and the failure looks like the
 * product. Quiet is the condition those assertions mean, and it is two things:
 * nothing in flight, and a turn that started nothing new.
 *
 * The bound is wall clock, so a slower machine waits longer instead of
 * failing, and a bar that never settles fails as a readable timeout rather
 * than hanging the suite.
 */
async function settle(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await turn();
    if (reads.inFlight === 0) {
      const started = reads.started;
      await turn();
      if (reads.inFlight === 0 && reads.started === started) return;
    }
    if (Date.now() >= deadline) {
      assert.fail(
        `the bar was still loading after ${timeoutMs} ms: ${reads.inFlight} request(s) in flight`,
      );
    }
  }
}

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

function openDialogs(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(
    (node) =>
      node.props.role === "dialog" && node.props["data-state"] !== "closed",
  );
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
    openDialogs(bar.renderer.root).length,
    0,
  );
  await bar.open();
  assert.equal(
    openDialogs(bar.renderer.root).length,
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

test("backdrop dismissal discards the modal draft", async () => {
  const bar = await mountBar();

  await bar.open();
  await bar.toggleProvider("GitHub");
  const backdrop = bar.renderer.root.find(
    (node) =>
      node.type === "div" &&
      node.props["aria-hidden"] === "true",
  );
  await act(async () => backdrop.props.onMouseDown({
    target: backdrop,
    currentTarget: backdrop,
  }));
  assert.deepEqual(bar.changes, []);
  assert.equal(
    openDialogs(bar.renderer.root).length,
    0,
  );
  await act(async () => bar.renderer.unmount());
});

test("the shared modal dismisses on Escape and wraps Tab focus", async () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const changes: WorkflowRepositoryScope[] = [];
  let root: DomRoot | undefined;

  try {
    await act(async () => {
      root = createDomRoot(container);
      root.render(
        <RepositoryCatalogProvider
          initial={{
            status: "ready",
            repositories: CATALOG,
            providers: [
              { provider: "github", status: "ready" },
              { provider: "gitlab", status: "ready" },
            ],
          }}
        >
          <RepositoryScopeBar
            scope={{}}
            canEdit
            onChange={(next) => changes.push(next)}
          />
        </RepositoryCatalogProvider>,
      );
    });
    const configure = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Configure"),
    );
    assert.ok(configure);
    await act(async () => configure.click());

    const dialog = document.querySelector<HTMLElement>(
      '[role="dialog"][data-state="open"]',
    );
    assert.ok(dialog);
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    const github = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("GitHub"),
    );
    assert.ok(github);
    await act(async () => github.click());

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>([
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(",")));
    const first = focusable[0];
    const last = focusable.at(-1);
    assert.ok(first);
    assert.ok(last);

    last.focus();
    const forwardTab = new dom.window.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      dom.window.dispatchEvent(forwardTab);
    });
    assert.equal(forwardTab.defaultPrevented, true);
    assert.equal(document.activeElement === first, true);

    first.focus();
    const backwardTab = new dom.window.KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      dom.window.dispatchEvent(backwardTab);
    });
    assert.equal(backwardTab.defaultPrevented, true);
    assert.equal(document.activeElement === last, true);

    const escape = new dom.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      dom.window.dispatchEvent(escape);
    });
    assert.equal(escape.defaultPrevented, true);
    assert.equal(
      document.querySelector('[role="dialog"][data-state="open"]'),
      null,
    );
    assert.deepEqual(changes, []);
  } finally {
    await act(async () => root?.unmount());
    container.remove();
    dom.restore();
  }
});

test("catalog refresh drops a newly selected repository that disappears", async () => {
  const queue = [
    [gh("Blazity/ai-workflow-prod"), gh("Blazity/ai-workflow-demo")],
    [gh("Blazity/ai-workflow-demo")],
  ];
  // One refresh is two reads now: the catalog decides what may be pinned and
  // the directory is the fleet the bridge still offers, so the stub answers by
  // URL rather than by turn.
  const uninstallFetch = installFetch((url) => {
    if (url.startsWith("/api/repository-catalog")) {
      return Promise.resolve(
        Response.json({
          state: {
            activated: false,
            bridge: true,
            activatedAt: null,
            activatedById: null,
            activatedByLabel: null,
          },
          repositories: [],
        }),
      );
    }
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
  });

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
    await settle();
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
    await settle();

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
    uninstallFetch();
  }
});
