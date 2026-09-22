import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { PrePrChecksResponse, WorkflowEditorOptions } from "@shared/contracts";
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
// Node test environment does not provide; the panel links to /repositories.
(globalThis as { self?: unknown }).self = globalThis;

const options = {
  ticketStatusTargets: [],
  blockRegistry: {},
} as unknown as WorkflowEditorOptions;

function runChecksNode(params: FlowNodeDef["params"] = {}): FlowNodeDef {
  return { id: "n1", type: "run_checks", name: "Checks", x: 0, y: 0, params, inputs: {} };
}

const RESPONSE: PrePrChecksResponse = {
  current: {
    version: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdById: "u1",
    createdByLabel: "Filip",
    restoredFromVersion: null,
    config: {
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          groups: {
            checks: { commands: ["pnpm test"] },
            lint: { commands: ["pnpm lint"] },
            unit: { commands: ["pnpm unit"] },
          },
          gateGroups: ["checks", "lint"],
        },
        {
          provider: "github",
          repoPath: "acme/api",
          groups: { checks: { commands: ["go test"] }, vet: { commands: ["go vet"] } },
        },
      ],
    },
  },
  versions: [],
};

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

function byLabel(renderer: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return renderer.root.findAll((i) => i.props["aria-label"] === label)[0];
}

function radio(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const found = renderer.root
    .findAll((i) => i.type === "label")
    .find((i) => nodeText(i).trim() === label);
  assert.ok(found, `expected a radio labelled ${label}`);
  return found!.findAll((i) => i.type === "input")[0]!;
}

/** Pins are written "provider:owner/name", the same composite identity the
 *  editor keys repositories by. A bare path pins the GitHub repository. */
function pinnedScope(pinned: string[]) {
  return {
    repositories: pinned.map((entry) => {
      const [provider, repoPath] = entry.includes(":")
        ? (entry.split(":") as ["github" | "gitlab", string])
        : (["github", entry] as const);
      return { provider, repoPath };
    }),
  };
}

function panel(
  node: FlowNodeDef,
  onChange: (path: string, value: unknown) => void,
  canEdit: boolean,
  pinned: string[] | null,
) {
  const fields = (
    <ConfigFields node={node} options={options} canEdit={canEdit} onChange={onChange} />
  );
  if (pinned === null) return fields;
  return (
    <RepositoryScopeProvider scope={pinnedScope(pinned)} onChange={() => undefined}>
      {fields}
    </RepositoryScopeProvider>
  );
}

async function render(
  node: FlowNodeDef,
  onChange: (path: string, value: unknown) => void = () => undefined,
  canEdit = true,
  pinned: string[] | null = null,
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(panel(node, onChange, canEdit, pinned));
  });
  await settle();
  return renderer;
}

async function rerender(
  renderer: ReactTestRenderer,
  node: FlowNodeDef,
  onChange: (path: string, value: unknown) => void = () => undefined,
): Promise<void> {
  await act(async () => renderer.update(panel(node, onChange, true, null)));
  await settle();
}

test("with no named groups run_checks shows the gate selection it will actually resolve, per repository", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const renderer = await render(runChecksNode({}));
  try {
    const html = nodeText(renderer.root);
    assert.match(html, /Selection:/);
    // An absent groups list used to be an invisible mode; it resolves to the
    // repository's gateGroups, or to every group when it sets none.
    assert.match(html, /acme\/web · gate groups: checks, lint/);
    assert.match(html, /acme\/api · every group runs at the gate \(2 groups\)/);
    assert.equal(radio(renderer, "Gate groups (default)").props.checked, true);
    assert.equal(radio(renderer, "Named groups").props.checked, false);
    // The gate mode offers no picker: there is nothing to select.
    assert.equal(byLabel(renderer, "Run group checks"), undefined);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("a node with named groups reads back as Named, and switching to Gate groups clears them", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const changes: [string, unknown][] = [];
  const renderer = await render(runChecksNode({ groups: ["lint"] }), (path, value) =>
    changes.push([path, value]),
  );
  try {
    assert.equal(radio(renderer, "Named groups").props.checked, true);
    const html = nodeText(renderer.root);
    assert.match(html, /lint1\/2 repos/);
    // A named selection is report-only: the block records no publication gate.
    assert.match(
      html,
      /A named selection is report-only and does not record the publication gate\./,
    );

    await act(async () => radio(renderer, "Gate groups (default)").props.onChange({}));
    assert.deepEqual(changes.at(-1), ["params.groups", undefined]);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("choosing Named groups opens the picker before any name has been selected", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const changes: [string, unknown][] = [];
  const renderer = await render(runChecksNode({}), (path, value) => changes.push([path, value]));
  try {
    await act(async () => radio(renderer, "Named groups").props.onChange({}));
    const checks = byLabel(renderer, "Run group checks");
    assert.ok(checks, "expected the picker once Named groups is chosen");
    await act(async () => checks!.props.onChange({ target: { checked: true } }));
    assert.deepEqual(changes.at(-1), ["params.groups", ["checks"]]);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("run_checks words the undeclared-group warning for its own reporting, not run_scripts'", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const renderer = await render(runChecksNode({ groups: ["nonexistent", "vet"] }));
  try {
    const html = nodeText(renderer.root);
    assert.match(
      html,
      /No repository declares "nonexistent"\. This block will run nothing for it and still report outcome: passed\./,
    );
    assert.doesNotMatch(html, /allPassed will be false/);
    assert.match(
      html,
      /vet: not declared by every repository in scope; they run nothing there\. The block can still report passed\./,
    );
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("explicit commands take the group selection out of play and one button puts it back", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const changes: [string, unknown][] = [];
  const renderer = await render(runChecksNode({ commands: ["pnpm test"] }), (path, value) =>
    changes.push([path, value]),
  );
  try {
    // Commands win at run time, so neither selection mode describes the block
    // while any are set.
    assert.equal(radio(renderer, "Gate groups (default)").props.disabled, true);
    assert.equal(radio(renderer, "Named groups").props.disabled, true);

    const clear = renderer.root
      .findAll((i) => i.type === "button")
      .find((i) => nodeText(i).trim() === "Clear commands to select groups");
    assert.ok(clear, "expected a clear-commands button while commands are set");
    await act(async () => clear!.props.onClick());
    assert.deepEqual(changes.at(-1), ["params.commands", undefined]);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("a read-only run_checks panel still shows which groups are selected", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const renderer = await render(runChecksNode({ groups: ["lint"] }), () => undefined, false);
  try {
    // Before this the chips and every scrap of context vanished with canEdit.
    assert.match(nodeText(renderer.root), /lint1\/2 repos/);
    assert.equal(byLabel(renderer, "Run group lint"), undefined);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("filling both Commands and Groups surfaces an inline error; filling only one does not", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const ERROR_TEXT = /Commands and Groups are both set\. They are mutually exclusive: clear one\s+before saving\./;

  try {
    const both = await render(runChecksNode({ commands: ["pnpm test"], groups: ["checks"] }));
    try {
      // An author who fills both used to keep an enabled Save and only learn
      // at publish time from the server's superRefine; the client mirrors
      // that rule the same way other node validation already does.
      assert.match(nodeText(both.root), ERROR_TEXT);
    } finally {
      await act(async () => both.unmount());
    }

    const commandsOnly = await render(runChecksNode({ commands: ["pnpm test"] }));
    try {
      assert.doesNotMatch(nodeText(commandsOnly.root), ERROR_TEXT);
    } finally {
      await act(async () => commandsOnly.unmount());
    }

    const groupsOnly = await render(runChecksNode({ groups: ["checks"] }));
    try {
      assert.doesNotMatch(nodeText(groupsOnly.root), ERROR_TEXT);
    } finally {
      await act(async () => groupsOnly.unmount());
    }

    const neither = await render(runChecksNode({}));
    try {
      assert.doesNotMatch(nodeText(neither.root), ERROR_TEXT);
    } finally {
      await act(async () => neither.unmount());
    }
  } finally {
    restore();
  }
});

test("unchecking the last group stays in Named mode and blocks Save instead of re-arming the gate", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const changes: [string, unknown][] = [];
  const record = (path: string, value: unknown) => changes.push([path, value]);
  const renderer = await render(runChecksNode({ groups: ["lint"] }), record);
  try {
    await act(async () =>
      byLabel(renderer, "Run group lint")!.props.onChange({ target: { checked: false } }),
    );
    // Not undefined: clearing the param is what a switch to Gate groups means,
    // and doing it here silently swapped the block for a different one.
    assert.deepEqual(changes.at(-1), ["params.groups", []]);

    await rerender(renderer, runChecksNode({ groups: [] }), record);
    assert.equal(radio(renderer, "Named groups").props.checked, true);
    const html = nodeText(renderer.root);
    // The picker stays up so the author can pick, and the state is named as an
    // error rather than quietly resolving to the gate.
    assert.ok(byLabel(renderer, "Run group lint"), "the picker must stay visible");
    assert.match(html, /No groups selected\. Pick at least one, or switch back to Gate groups\./);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("a Gate and back round trip restores the named selection instead of destroying it", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const changes: [string, unknown][] = [];
  const record = (path: string, value: unknown) => changes.push([path, value]);
  const renderer = await render(runChecksNode({ groups: ["checks", "lint"] }), record);
  try {
    await act(async () => radio(renderer, "Gate groups (default)").props.onChange({}));
    assert.deepEqual(changes.at(-1), ["params.groups", undefined]);

    await rerender(renderer, runChecksNode({}), record);
    assert.equal(radio(renderer, "Gate groups (default)").props.checked, true);

    await act(async () => radio(renderer, "Named groups").props.onChange({}));
    // Looking at what the gate resolves to must not cost the author the
    // selection they had typed.
    assert.deepEqual(changes.at(-1), ["params.groups", ["checks", "lint"]]);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("the selection mode does not leak from one node onto the next", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const renderer = await render(runChecksNode({ groups: ["lint"] }));
  try {
    assert.equal(radio(renderer, "Named groups").props.checked, true);

    // A second run_checks node with no groups is a Gate-mode node. Selecting it
    // used to inherit the first node's Named mode, which claimed a report-only
    // selection the node did not have.
    const other: FlowNodeDef = {
      id: "n2",
      type: "run_checks",
      name: "Other checks",
      x: 0,
      y: 0,
      params: {},
      inputs: {},
    };
    await rerender(renderer, other);
    assert.equal(radio(renderer, "Gate groups (default)").props.checked, true);
    const html = nodeText(renderer.root);
    assert.match(html, /every group runs at the gate/);
    assert.doesNotMatch(html, /A named selection is report-only/);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("a repository pin narrows the coverage denominator and the gate readout", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  // The pin is stored in the case the operator picked; matching ignores it.
  const renderer = await render(runChecksNode({ groups: ["lint"] }), () => undefined, true, [
    "ACME/Web",
  ]);
  try {
    const html = nodeText(renderer.root);
    // acme/api is out of scope, so counting it as a repository that does not
    // declare "lint" would report a gap this workflow can never hit.
    assert.match(html, /lint1\/1 pinned repos/);
    assert.doesNotMatch(html, /not declared by every repository in scope/);
    assert.doesNotMatch(html, /acme\/api/);
    // vet is declared only outside the pin, so it is not offered at all.
    assert.equal(byLabel(renderer, "Run group vet"), undefined);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("the pinned gate readout lists only pinned repositories", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const renderer = await render(runChecksNode({}), () => undefined, true, ["acme/api"]);
  try {
    const html = nodeText(renderer.root);
    assert.match(html, /acme\/api · every group runs at the gate \(2 groups\)/);
    assert.doesNotMatch(html, /acme\/web/);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("a viewer cannot clear commands to select groups", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const renderer = await render(
    runChecksNode({ commands: ["pnpm test"], groups: ["lint"] }),
    () => undefined,
    false,
  );
  try {
    const clear = renderer.root
      .findAll((i) => i.type === "button")
      .find((i) => nodeText(i).trim() === "Clear commands to select groups");
    assert.equal(clear, undefined, "a viewer must not get an action that edits params");
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

// The same org/name on two providers is two different repositories with two
// different script sets. Keying scope by path alone let a github pin drag the
// gitlab entry into every count and every gate row.
const SAME_PATH_TWO_PROVIDERS: PrePrChecksResponse = {
  current: {
    version: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdById: "u1",
    createdByLabel: "Filip",
    restoredFromVersion: null,
    config: {
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          groups: { checks: { commands: ["pnpm test"] } },
          gateGroups: ["checks"],
        },
        {
          provider: "gitlab",
          repoPath: "acme/web",
          groups: { deploy: { commands: ["make deploy"] } },
        },
      ],
    },
  },
  versions: [],
};

test("a pin matches on provider and path together, not on the path alone", async () => {
  const restore = installFetch(async () => Response.json(SAME_PATH_TWO_PROVIDERS));

  const renderer = await render(runChecksNode({ groups: ["checks"] }), () => undefined, true, [
    "acme/web",
  ]);
  try {
    const html = nodeText(renderer.root);
    // Only the pinned GitHub repository is in scope, so "checks" covers all of
    // it and the GitLab repository's own group is not on offer at all.
    assert.match(html, /checks1\/1 pinned repos/);
    assert.doesNotMatch(html, /not declared by every repository in scope/);
    assert.equal(byLabel(renderer, "Run group deploy"), undefined);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("the gate readout counts and qualifies the two providers separately", async () => {
  const restore = installFetch(async () => Response.json(SAME_PATH_TWO_PROVIDERS));

  // Pinned to the GitLab one, which sets no gate groups. The GitHub entry's
  // gate groups must not show up under a path that reads identical.
  const pinnedToGitlab = await render(runChecksNode({}), () => undefined, true, [
    "gitlab:acme/web",
  ]);
  try {
    const html = nodeText(pinnedToGitlab.root);
    assert.match(html, /acme\/web · every group runs at the gate \(1 group\)/);
    assert.doesNotMatch(html, /gate groups: checks/);
  } finally {
    await act(async () => pinnedToGitlab.unmount());
  }

  // Unpinned, both are in scope, so the bare path is ambiguous and each row
  // says which provider it is.
  const unpinned = await render(runChecksNode({}));
  try {
    const html = nodeText(unpinned.root);
    assert.match(html, /github:acme\/web · gate groups: checks/);
    assert.match(html, /gitlab:acme\/web · every group runs at the gate \(1 group\)/);
  } finally {
    await act(async () => unpinned.unmount());
    restore();
  }
});
