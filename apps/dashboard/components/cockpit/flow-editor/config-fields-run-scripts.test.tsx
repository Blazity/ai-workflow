import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { PrePrCheckRepositoryConfig, PrePrChecksResponse, WorkflowEditorOptions } from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import { ConfigFields } from "./config-fields";
import { RepositoryScopeProvider } from "./repository-scope-context";

/** What `settle` watches: the reads these panels have out, and how many they
 *  have started, so a turn that started another one is not mistaken for quiet. */
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
function installFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): () => void {
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

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// next/link's prefetch idle callback reaches for `self`, which the plain
// Node test environment does not provide (same gap memory.test.tsx and
// overview.test.tsx work around); the run_scripts panel links to /repositories.
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

/** One turn of what a browser does between two paints: the microtasks a
 *  resolved promise queues, and the macrotask a fetch body lands on. */
async function turn() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Lets the chain of loads a panel starts finish, and waits for exactly that.
 *
 * NEVER A COUNT OF TURNS. How many turns a chain costs is the runner's
 * business, so a fixed count passes on an idle machine and, on a loaded one,
 * returns while reads are still in flight: the assertion then reads a loading
 * panel and the failure looks like the product. Quiet is the condition those
 * assertions mean, and it is two things, because a read that lands usually
 * starts the next one: nothing in flight, and a turn that started nothing new.
 *
 * The bound is wall clock, so a slower machine waits longer instead of
 * failing, and a panel that never settles fails as a readable timeout rather
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
      assert.fail(`the panel was still loading after ${timeoutMs} ms: ${reads.inFlight} request(s) in flight`);
    }
  }
}

/**
 * Waits for the thing the next assertion is about, and fails with what the
 * panel showed instead. For a state a person reaches through work the panel
 * does after its reads land, where "nothing in flight" is true too early.
 */
async function waitForText(root: ReactTestInstance, expected: RegExp, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = nodeText(root);
    if (expected.test(seen)) return seen;
    if (Date.now() >= deadline) {
      assert.fail(`waited ${timeoutMs} ms for ${expected}, and the panel showed: ${seen.slice(0, 900)}`);
    }
    await turn();
  }
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
  const calls: string[] = [];
  const restore = installFetch(async (url: string) => {
    calls.push(url);
    return Response.json(MIXED);
  });

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
    restore();
  }
});

test("a coverage counter expands to the per-repository breakdown", async () => {
  const restore = installFetch(async () => Response.json(MIXED));

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
    restore();
  }
});

test("checking and unchecking a group writes params.groups, and clearing the last one drops the key", async () => {
  const restore = installFetch(async () => Response.json(MIXED));

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
    restore();
  }
});

test("a selected name repeated in params is written back once", async () => {
  const restore = installFetch(async () => Response.json(MIXED));

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
    restore();
  }
});

test("the add-a-name escape hatch accepts a group no repository declares yet and refuses an illegal one", async () => {
  const restore = installFetch(async () => Response.json(MIXED));

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
    restore();
  }
});

test("run_scripts splits its warnings: malformed is red and blocks, undeclared is amber, partial coverage is a note", async () => {
  const restore = installFetch(async () => Response.json(MIXED));

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
    restore();
  }
});

test("a group every repository declares gets no partial-coverage note", async () => {
  const restore = installFetch(async () => Response.json(MIXED));

  const renderer = await render(runScriptsNode({ groups: ["checks"] }));
  try {
    const html = nodeText(renderer.root);
    assert.doesNotMatch(html, /not declared by every repository/);
    assert.doesNotMatch(html, /No repository declares/);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("an all-legacy tenant does not falsely flag the implied \"checks\" group as undeclared", async () => {
  // Every repository here is flat commands, no explicit groups key at all.
  // The engine normalizes each one into a single "checks" group at run time,
  // but the stored config never spells that out; without unioning the implied
  // name in, a freshly dropped run_scripts block (default groups: ["checks"])
  // saw a false amber warning even though it runs fine.
  const restore = installFetch(async () =>
    Response.json(
      response([
        { provider: "github", repoPath: "acme/web", commands: ["pnpm test"] },
        { provider: "gitlab", repoPath: "acme/legacy", commands: ["make check"] },
      ]),
    ));

  const renderer = await render(runScriptsNode({ groups: ["checks"] }));
  try {
    const html = nodeText(renderer.root);
    assert.doesNotMatch(html, /No repository declares/);
    assert.match(html, /checks2\/2 repos/);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("a failed catalog fetch says so, offers a retry, and never claims a name is undeclared", async () => {
  let attempt = 0;
  const restore = installFetch(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("network down");
    return Response.json(MIXED);
  });

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
    restore();
  }
});

test("loading and a genuinely empty configuration read as two different states", async () => {
  let resolveFetch!: (value: Response) => void;
  // The answer is held open from before the first call, so the resolver is
  // there whatever turn the read reaches the handler on.
  const held = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const restoreLoading = installFetch(async () => held);

  // The read is deliberately still out, so this one waits for the loading
  // words themselves: quiet is a condition that will never come here.
  let loading!: ReactTestRenderer;
  await act(async () => {
    loading = create(
      <ConfigFields
        node={runScriptsNode({ groups: ["checks"] })}
        options={options}
        canEdit
        onChange={() => undefined}
      />,
    );
  });
  try {
    await waitForText(loading.root, /Configured:\s*loading\.\.\./);
  } finally {
    await act(async () => resolveFetch(Response.json(response([]))));
    // Let the freed read land before the next test half installs its own
    // fetch, or its counters start life owing one answer.
    await settle();
    await act(async () => loading.unmount());
    restoreLoading();
  }

  const restore = installFetch(async () => Response.json(response([])));
  const empty = await render(runScriptsNode({ groups: ["checks"] }));
  try {
    const html = nodeText(empty.root);
    assert.match(html, /No repository scripts configured yet\./);
    assert.doesNotMatch(html, /Configured:\s*loading/);
    assert.doesNotMatch(html, /Configured:\s*unavailable/);
  } finally {
    await act(async () => empty.unmount());
    restore();
  }
});

test("a read-only panel still shows the selected groups instead of an empty field", async () => {
  const restore = installFetch(async () => Response.json(MIXED));

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
    restore();
  }
});

test("the panel keeps the runtime notes and opens Repository scripts in a new tab", async () => {
  const restore = installFetch(async () => Response.json(MIXED));

  const renderer = await render(runScriptsNode({ groups: ["checks"] }));
  try {
    // Deliberate, previously undocumented behavior: this is not a
    // per-changed-repository filter.
    assert.match(
      nodeText(renderer.root),
      /The block runs the\s+selected groups on every repository in the run workspace, whether or not that\s+repository changed\./,
    );
    const link = renderer.root.findAll((i) => i.props.href === "/repositories")[0];
    assert.ok(link, "expected a link to Repository scripts");
    // Client-side navigation out of the editor discards the unsaved canvas.
    assert.equal(link!.props.target, "_blank");
    assert.equal(link!.props.rel, "noreferrer");
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("several partially covered groups collapse into one note instead of a stack of identical boxes", async () => {
  const restore = installFetch(async () => Response.json(MIXED));

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
    restore();
  }
});

test("a repository pin is the population the coverage counters count", async () => {
  const restore = installFetch(async () => Response.json(MIXED));

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
    restore();
  }
});

test("a pin that selects repositories nobody configured says so, rather than claiming nothing is configured", async () => {
  const restore = installFetch(async () => Response.json(MIXED));

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
    restore();
  }
});
