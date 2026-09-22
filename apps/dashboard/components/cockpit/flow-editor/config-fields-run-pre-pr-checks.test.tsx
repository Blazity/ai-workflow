import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { PrePrChecksResponse, WorkflowEditorOptions } from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import { ConfigFields } from "./config-fields";

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

function node(params: FlowNodeDef["params"] = {}): FlowNodeDef {
  return { id: "n1", type: "run_pre_pr_checks", name: "Checks", x: 0, y: 0, params, inputs: {} };
}

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
            deps: { commands: ["pnpm install"] },
            lint: { commands: ["pnpm lint"] },
            unit: { commands: ["pnpm test"] },
          },
          gateGroups: ["deps", "lint", "unit"],
        },
        {
          provider: "github",
          repoPath: "acme/api",
          groups: {
            a: { commands: ["a"] },
            b: { commands: ["b"] },
            c: { commands: ["c"] },
            d: { commands: ["d"] },
            e: { commands: ["e"] },
          },
        },
      ],
    },
  },
  versions: [],
};

async function renderPanelWithConfig(n: FlowNodeDef): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ConfigFields node={n} options={options} canEdit onChange={() => undefined} />,
    );
  });
  await settle();
  return renderer;
}

test("the gate panel names what it will require, per repository, instead of pointing elsewhere", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const renderer = await renderPanelWithConfig(node({}));
  try {
    const html = nodeText(renderer.root);
    assert.match(html, /Gate selection/);
    assert.match(html, /acme\/web · gate groups: deps, lint, unit/);
    // No gate groups means every declared group, and the count is the number an
    // operator can check against the scripts screen.
    assert.match(html, /acme\/api · every group runs at the gate \(5 groups\)/);
    assert.match(
      html,
      /This block runs the required groups on repositories the run changed\./,
    );
    // The block runs script groups, not free-standing commands, and calling
    // them commands is what sent authors looking for a field that never
    // existed here.
    assert.doesNotMatch(html, /Commands/);
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("the gate panel opens the Repositories page in a new tab", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const renderer = await renderPanelWithConfig(node({}));
  try {
    const link = renderer.root.findAll((i) => i.props.href === "/repositories")[0];
    assert.ok(link, "expected a link to the Repositories page");
    // A client-side navigation out of the editor discards the unsaved canvas.
    assert.equal(link!.props.target, "_blank");
    assert.equal(link!.props.rel, "noreferrer");
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("a positive legacy maxFixCycles gets an inert-parameter note instead of silently doing nothing", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  const renderer = await renderPanelWithConfig(node({ maxFixCycles: 3 }));
  try {
    assert.match(
      nodeText(renderer.root),
      /Fix cycles no longer apply: the repair loop was removed\. The value is kept only for compatibility\./,
    );
  } finally {
    await act(async () => renderer.unmount());
    restore();
  }
});

test("a node with no maxFixCycles or a value of 0 gets no inert-parameter note", async () => {
  const restore = installFetch(async () => Response.json(RESPONSE));

  try {
    const withoutParam = await renderPanelWithConfig(node({}));
    try {
      assert.doesNotMatch(nodeText(withoutParam.root), /Fix cycles no longer apply/);
    } finally {
      await act(async () => withoutParam.unmount());
    }

    const zero = await renderPanelWithConfig(node({ maxFixCycles: 0 }));
    try {
      assert.doesNotMatch(nodeText(zero.root), /Fix cycles no longer apply/);
    } finally {
      await act(async () => zero.unmount());
    }
  } finally {
    restore();
  }
});
