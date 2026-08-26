import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { PrePrCheckRepositoryConfig, PrePrChecksResponse, WorkflowEditorOptions } from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import { ConfigFields } from "./config-fields";
import { RepositoryScopeProvider } from "./repository-scope-context";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// next/link's prefetch idle callback reaches for `self`, which the plain
// Node test environment does not provide (same gap memory.test.tsx and
// overview.test.tsx work around); the run_scripts panel links to /scripts.
(globalThis as { self?: unknown }).self = globalThis;

const options = {
  ticketStatusTargets: [],
  blockRegistry: {},
} as unknown as WorkflowEditorOptions;

function runScriptsNode(params: FlowNodeDef["params"] = {}): FlowNodeDef {
  return { id: "n1", type: "run_scripts", name: "Scripts", x: 0, y: 0, params, inputs: {} };
}

function response(repositories: PrePrCheckRepositoryConfig[]): PrePrChecksResponse {
  return {
    current: {
      version: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      createdById: "u1",
      createdByLabel: "Filip",
      restoredFromVersion: null,
      config: { repositories },
    },
    versions: [],
  };
}

// One repository declaring everything, one declaring a subset, one legacy flat
// repository whose implied "checks" group only exists at run time.
const MIXED = response([
  {
    provider: "github",
    repoPath: "acme/web",
    groups: {
      checks: { commands: ["pnpm test"] },
      lint: { commands: ["pnpm lint"] },
      format: { commands: ["pnpm format"], restoreTree: false },
    },
  },
  { provider: "github", repoPath: "acme/api", groups: { checks: { commands: ["go test"] } } },
  { provider: "gitlab", repoPath: "acme/legacy", commands: ["make check"] },
]);

function nodeText(instance: ReactTestInstance): string {
  return instance.children
    .flatMap((child) => (typeof child === "string" ? [child] : [nodeText(child)]))
    .join("");
}

async function settle() {
  await act(async () => {});
  await act(async () => {});
}

function byLabel(renderer: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return renderer.root.findAll((i) => i.props["aria-label"] === label)[0];
}

function buttonWithText(renderer: ReactTestRenderer, text: string): ReactTestInstance | undefined {
  return renderer.root
    .findAll((i) => i.type === "button")
    .find((i) => nodeText(i).trim() === text);
}

async function render(
  node: FlowNodeDef,
  onChange: (path: string, value: unknown) => void = () => undefined,
  canEdit = true,
  pinned: string[] | null = null,
): Promise<ReactTestRenderer> {
  const fields = (
    <ConfigFields node={node} options={options} canEdit={canEdit} onChange={onChange} />
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      pinned === null ? (
        fields
      ) : (
        <RepositoryScopeProvider
          scope={{ repositories: pinned.map((repoPath) => ({ provider: "github", repoPath })) }}
          onChange={() => undefined}
        >
          {fields}
        </RepositoryScopeProvider>
      ),
    );
  });
  await settle();
  return renderer;
}

test("the Groups picker lists every configured group with its repository coverage, worst covered last", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return Response.json(MIXED);
  }) as typeof fetch;

  const renderer = await render(runScriptsNode({ groups: ["checks"] }));
  try {
    assert.equal(calls[0], "/api/pre-pr-checks");
    const html = nodeText(renderer.root);
    // checks: acme/web, acme/api and the legacy repo's implied group. lint and
    // format: acme/web only. The denominator is every configured repository,
    // not just the ones declaring the group.
    assert.match(html, /checks3\/3 repos/);
    assert.match(html, /lint1\/3 repos/);
    assert.match(html, /format/);
    // Coverage descending, then name: checks (3) before format and lint (1),
    // and format before lint on the name tiebreak.
    assert.ok(
      html.indexOf("checks3/3") < html.indexOf("format") &&
        html.indexOf("format") < html.indexOf("lint1/3"),
      `expected coverage-descending order, got ${html}`,
    );
    // A group that runs with restoreTree false is the one that can break
    // publication, so it carries a tag rather than hiding behind its name.
    assert.match(html, /formatWrites/);
    assert.doesNotMatch(html, /checks3\/3 reposWrites/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a coverage counter expands to the per-repository breakdown", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(MIXED)) as typeof fetch;

  const renderer = await render(runScriptsNode({ groups: ["lint"] }));
  try {
    assert.doesNotMatch(nodeText(renderer.root), /acme\/api/);
    const toggle = byLabel(renderer, "Repository coverage for lint");
    assert.ok(toggle, "expected an expandable coverage counter for lint");
    await act(async () => toggle!.props.onClick());

    const html = nodeText(renderer.root);
    // Every configured repository is listed, declaring or not: "1/3" is only
    // actionable once the two that will run nothing are named.
    assert.match(html, /✓ acme\/web/);
    assert.match(html, /- acme\/api/);
    assert.match(html, /- acme\/legacy/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("checking and unchecking a group writes params.groups, and clearing the last one drops the key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(MIXED)) as typeof fetch;

  const changes: [string, unknown][] = [];
  const renderer = await render(runScriptsNode({ groups: ["checks"] }), (path, value) =>
    changes.push([path, value]),
  );
  try {
    const lint = byLabel(renderer, "Run group lint");
    assert.ok(lint, "expected a checkbox for the configured group lint");
    await act(async () => lint!.props.onChange({ target: { checked: true } }));
    assert.deepEqual(changes.at(-1), ["params.groups", ["checks", "lint"]]);

    const checks = byLabel(renderer, "Run group checks");
    await act(async () => checks!.props.onChange({ target: { checked: false } }));
    // An empty groups array is refused server-side, so the last uncheck clears
    // the param instead of writing [].
    assert.deepEqual(changes.at(-1), ["params.groups", undefined]);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a selected name repeated in params is written back once", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(MIXED)) as typeof fetch;

  const changes: [string, unknown][] = [];
  // The old free-text field never deduped, so a legacy definition can carry
  // the same name twice.
  const renderer = await render(runScriptsNode({ groups: ["checks", "checks"] }), (path, value) =>
    changes.push([path, value]),
  );
  try {
    const lint = byLabel(renderer, "Run group lint");
    await act(async () => lint!.props.onChange({ target: { checked: true } }));
    assert.deepEqual(changes.at(-1), ["params.groups", ["checks", "lint"]]);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("the add-a-name escape hatch accepts a group no repository declares yet and refuses an illegal one", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(MIXED)) as typeof fetch;

  const changes: [string, unknown][] = [];
  const renderer = await render(runScriptsNode({ groups: ["checks"] }), (path, value) =>
    changes.push([path, value]),
  );
  try {
    const input = byLabel(renderer, "Add a group name");
    assert.ok(input, "expected an add-a-group-name input");

    await act(async () => input!.props.onChange({ target: { value: "Not A Name" } }));
    assert.match(
      nodeText(renderer.root),
      /group name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens/,
    );
    const add = buttonWithText(renderer, "Add");
    assert.ok(add, "expected an Add button");
    await act(async () => add!.props.onClick());
    // Refused, not added: the server would reject it at Deploy anyway.
    assert.equal(changes.length, 0);

    await act(async () => input!.props.onChange({ target: { value: "e2e-smoke" } }));
    await act(async () => buttonWithText(renderer, "Add")!.props.onClick());
    assert.deepEqual(changes.at(-1), ["params.groups", ["checks", "e2e-smoke"]]);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("run_scripts splits its warnings: malformed is red and blocks, undeclared is amber, partial coverage is a note", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(MIXED)) as typeof fetch;

  const renderer = await render(runScriptsNode({ groups: ["lint", "nonexistent", "Bad Name"] }));
  try {
    const html = nodeText(renderer.root);
    assert.match(html, /"Bad Name" is not a valid group name/);
    assert.match(
      html,
      /No repository declares "nonexistent"\. This block will report it as not_run and allPassed will be false\./,
    );
    assert.match(
      html,
      /lint: not declared by every repository in scope; they run nothing there\. The block can still report allPassed\./,
    );
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a group every repository declares gets no partial-coverage note", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(MIXED)) as typeof fetch;

  const renderer = await render(runScriptsNode({ groups: ["checks"] }));
  try {
    const html = nodeText(renderer.root);
    assert.doesNotMatch(html, /not declared by every repository/);
    assert.doesNotMatch(html, /No repository declares/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("an all-legacy tenant does not falsely flag the implied \"checks\" group as undeclared", async () => {
  // Every repository here is flat commands, no explicit groups key at all.
  // The engine normalizes each one into a single "checks" group at run time,
  // but the stored config never spells that out; without unioning the implied
  // name in, a freshly dropped run_scripts block (default groups: ["checks"])
  // saw a false amber warning even though it runs fine.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      response([
        { provider: "github", repoPath: "acme/web", commands: ["pnpm test"] },
        { provider: "gitlab", repoPath: "acme/legacy", commands: ["make check"] },
      ]),
    )) as typeof fetch;

  const renderer = await render(runScriptsNode({ groups: ["checks"] }));
  try {
    const html = nodeText(renderer.root);
    assert.doesNotMatch(html, /No repository declares/);
    assert.match(html, /checks2\/2 repos/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a failed catalog fetch says so, offers a retry, and never claims a name is undeclared", async () => {
  const originalFetch = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = (async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("network down");
    return Response.json(MIXED);
  }) as typeof fetch;

  const renderer = await render(runScriptsNode({ groups: ["checks", "nonexistent"] }));
  try {
    const failed = nodeText(renderer.root);
    assert.match(failed, /Configured:\s*unavailable/);
    assert.match(failed, /Group names could not be checked against Repository scripts\./);
    // The union is unknown, so an unknown-group claim would be invented.
    assert.doesNotMatch(failed, /No repository declares/);
    // Coverage is unknowable too, so no counter pretends otherwise.
    assert.doesNotMatch(failed, /\d+\/\d+ repos/);

    const retry = buttonWithText(renderer, "Retry");
    assert.ok(retry, "expected a retry button on a failed catalog fetch");
    await act(async () => retry!.props.onClick());
    await settle();

    const reloaded = nodeText(renderer.root);
    assert.doesNotMatch(reloaded, /Configured:\s*unavailable/);
    assert.match(reloaded, /checks3\/3 repos/);
    assert.match(reloaded, /No repository declares "nonexistent"/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("loading and a genuinely empty configuration read as two different states", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFetch!: (value: Response) => void;
  globalThis.fetch = (async () =>
    new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as typeof fetch;

  const loading = await render(runScriptsNode({ groups: ["checks"] }));
  try {
    assert.match(nodeText(loading.root), /Configured:\s*loading\.\.\./);
  } finally {
    await act(async () => resolveFetch(Response.json(response([]))));
    await act(async () => loading.unmount());
  }

  globalThis.fetch = (async () => Response.json(response([]))) as typeof fetch;
  const empty = await render(runScriptsNode({ groups: ["checks"] }));
  try {
    const html = nodeText(empty.root);
    assert.match(html, /No repository scripts configured yet\./);
    assert.doesNotMatch(html, /Configured:\s*loading/);
    assert.doesNotMatch(html, /Configured:\s*unavailable/);
  } finally {
    await act(async () => empty.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a read-only panel still shows the selected groups instead of an empty field", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(MIXED)) as typeof fetch;

  const renderer = await render(runScriptsNode({ groups: ["lint"] }), () => undefined, false);
  try {
    const html = nodeText(renderer.root);
    assert.match(html, /lint1\/3 repos/);
    assert.equal(
      renderer.root.findAll((i) => i.props["aria-label"] === "Run group lint").length,
      0,
      "a read-only panel must not offer checkboxes",
    );
    assert.equal(byLabel(renderer, "Add a group name"), undefined);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("the panel keeps the runtime notes and opens Repository scripts in a new tab", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(MIXED)) as typeof fetch;

  const renderer = await render(runScriptsNode({ groups: ["checks"] }));
  try {
    // Deliberate, previously undocumented behavior: this is not a
    // per-changed-repository filter.
    assert.match(
      nodeText(renderer.root),
      /The block runs the\s+selected groups on every repository in the run workspace, whether or not that\s+repository changed\./,
    );
    const link = renderer.root.findAll((i) => i.props.href === "/scripts")[0];
    assert.ok(link, "expected a link to Repository scripts");
    // Client-side navigation out of the editor discards the unsaved canvas.
    assert.equal(link!.props.target, "_blank");
    assert.equal(link!.props.rel, "noreferrer");
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("several partially covered groups collapse into one note instead of a stack of identical boxes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(MIXED)) as typeof fetch;

  const renderer = await render(runScriptsNode({ groups: ["lint", "format"] }));
  try {
    const html = nodeText(renderer.root);
    assert.match(
      html,
      /format, lint: not declared by every repository in scope; they run nothing there\. The block can still report allPassed\./,
    );
    // One note, not one per group: partial coverage is the norm on a
    // heterogeneous tenant, and a stack of boxes is what stops being read.
    assert.equal(html.match(/not declared by every repository in scope/g)?.length, 1);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a repository pin is the population the coverage counters count", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(MIXED)) as typeof fetch;

  const renderer = await render(runScriptsNode({ groups: ["lint"] }), () => undefined, true, [
    "acme/web",
  ]);
  try {
    const html = nodeText(renderer.root);
    // acme/web declares lint, and it is the only repository this workflow can
    // touch: "1/3 repos" described a gap the run can never hit.
    assert.match(html, /lint1\/1 pinned repos/);
    assert.doesNotMatch(html, /not declared by every repository in scope/);
    assert.doesNotMatch(html, /acme\/legacy/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a pin that selects repositories nobody configured says so, rather than claiming nothing is configured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(MIXED)) as typeof fetch;

  const renderer = await render(runScriptsNode({ groups: ["checks"] }), () => undefined, true, [
    "acme/unconfigured",
  ]);
  try {
    assert.match(
      nodeText(renderer.root),
      /None of the repositories pinned to this workflow has repository scripts configured\./,
    );
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});
