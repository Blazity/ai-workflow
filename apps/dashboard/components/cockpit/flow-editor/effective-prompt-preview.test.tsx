import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import type { WorkflowDefinitionV2 } from "@shared/contracts";

import { PagedCacheProvider } from "../agent-visibility/paged";
import {
  EffectivePromptPreview,
  EffectivePromptPreviewResultView,
  type EffectivePromptPreviewResponse,
} from "./effective-prompt-preview";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { self?: typeof globalThis }).self ??= globalThis;

const result: EffectivePromptPreviewResponse = {
  blockId: "implementation",
  prompt: "PROFILE\n\nBLOCK\n\nRUNTIME",
  hash: "compiled-hash",
  sections: [
    {
      kind: "profile",
      title: "Harness Profile: Codex",
      content: "PROFILE",
      hash: "profile-hash",
      provenance: [
        {
          kind: "profile",
          id: "system-codex",
          version: 1,
          hash: "profile-manifest-hash",
        },
      ],
    },
    {
      kind: "block",
      title: "Block role and task",
      content: "BLOCK",
      hash: "block-hash",
      provenance: [
        {
          kind: "prompt",
          id: "4:implementation",
          version: 3,
          hash: "prompt-body-hash",
        },
      ],
    },
    {
      kind: "runtime",
      title: "Runtime data",
      content: "RUNTIME",
      hash: "runtime-hash",
      provenance: [],
    },
  ],
  provenance: [],
  unresolvedSources: [
    {
      kind: "repository",
      reference: "owner/repository/AGENTS.md",
      message: "Available after workspace preparation.",
    },
  ],
  issues: [
    {
      code: "prompt_slot_missing",
      severity: "error",
      nodeId: "implementation",
      path: "/configuration/promptSlotBindings/plan",
      message: 'Prompt slot "plan" needs a value.',
    },
  ],
};

test("effective prompt preview preserves section order and shows provenance", () => {
  const html = renderToStaticMarkup(
    <EffectivePromptPreviewResultView result={result} />,
  );

  const profile = html.indexOf("Harness Profile: Codex");
  const block = html.indexOf("Block role and task");
  const runtime = html.indexOf("Runtime data");
  assert.ok(profile >= 0 && profile < block && block < runtime);
  assert.match(html, /system-codex/);
  assert.match(html, /profile-manifest-hash/);
  assert.match(html, /prompt-body-hash/);
  assert.match(html, /Compiled prompt · compiled-hash/);
});

test("effective prompt preview exposes runtime-only sources and structured errors", () => {
  const html = renderToStaticMarkup(
    <EffectivePromptPreviewResultView result={result} />,
  );

  assert.match(html, /Resolved at runtime/);
  assert.match(html, /owner\/repository\/AGENTS.md/);
  assert.match(html, /Preview errors/);
  assert.match(html, /promptSlotBindings\/plan/);
  assert.match(html, /needs a value/);
});

/* ── The panel: two views a person can tell apart ──────────────────────── */

const definition = { schemaVersion: 2, nodes: [], edges: [] } as unknown as WorkflowDefinitionV2;

function text(node: ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap((child) => child.children.filter((entry): entry is string => typeof entry === "string"))
    .join(" ")
    .replace(/\s+/g, " ");
}

function click(root: ReactTestInstance, label: string) {
  const found = root
    .findAll((node) => node.type === "button")
    .filter((node) => text(node).includes(label));
  assert.equal(found.length, 1, `expected one button containing "${label}", found ${found.length}`);
  act(() => found[0]!.props.onClick());
}

/** What `settle` watches: the reads this panel has out, and how many it has
 *  started, so a turn that started another one is not mistaken for quiet.
 *  One mount per test, and this file's tests run one at a time. */
interface Reads {
  inFlight: number;
  started: number;
}
let reads: Reads = { inFlight: 0, started: 0 };

function mount(t: TestContext): { root: ReactTestInstance; requests: string[] } {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  // The count belongs to this installation, not to the file: a test may end
  // while an answer is still on its way, and a count the next test had zeroed
  // would go negative when that answer lands, so nothing would ever look quiet
  // again. A leftover answer decrements the count of the test it belongs to,
  // where nobody is watching any more.
  const mine: Reads = { inFlight: 0, started: 0 };
  reads = mine;
  globalThis.fetch = ((input: string) => {
    const path = String(input);
    requests.push(path);
    mine.inFlight += 1;
    mine.started += 1;
    // Every answer lands a turn later, the way a response does: resolving in
    // the caller's own microtask is what let a counted wait look reliable.
    const answer = async () => {
      const slow = Number(process.env.FIXTURE_SLOW_MS ?? 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(slow, 0)));
      if (path.includes("prompt-preview")) return Response.json(result);
      return Response.json({
        schemaVersion: 1,
        definitionId: 4,
        nodeId: "implementation",
        blockType: "implementation_agent",
        sendsPrompts: true,
        ranIn: null,
        attempt: null,
        absent: { kind: "never_ran" },
      });
    };
    return answer().finally(() => {
      mine.inFlight -= 1;
    });
  }) as typeof globalThis.fetch;
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <PagedCacheProvider>
        <EffectivePromptPreview definitionId={4} definition={definition} blockId="implementation" />
      </PagedCacheProvider>,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  });
  return { root: renderer.root, requests };
}

/** One turn of what a browser does between two paints: the microtasks a
 *  resolved promise queues, and the macrotask a fetch body lands on. */
async function turn() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Lets the read a view starts finish, and waits for exactly that.
 *
 * NEVER A COUNT OF TURNS. Opening a view here starts a fetch whose body lands
 * a turn or more after the call, and how many turns that costs is the runner's
 * business: a fixed count passes on an idle machine and, on a loaded one,
 * returns while the compile is still in flight, so the assertion reads a
 * panel that is still loading and the failure looks like the product. Quiet is
 * the condition these assertions mean, and it is two things, because a read
 * that lands can start the next one: nothing in flight, and a turn that
 * started nothing new.
 *
 * The bound is wall clock, so a slower machine waits longer instead of
 * failing. `FIXTURE_SLOW_MS` delays every answer by that many milliseconds,
 * which is how this harness reproduces a runner slow enough to break a
 * counted wait.
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

test("opening the panel compiles the edit in hand and asks nothing about past runs", async (t) => {
  const { root, requests } = mount(t);
  click(root, "Preview");
  await settle();
  assert.equal(requests.filter((path) => path.includes("prompt-preview")).length, 1);
  // A read of a past run costs nothing while nobody is looking at it.
  assert.equal(requests.filter((path) => path.includes("last-briefing")).length, 0);
  assert.match(text(root), /Block role and task/);
});

test("what it sent last time and what it would send now are two named, separate views", async (t) => {
  const { root, requests } = mount(t);
  click(root, "Preview");
  await settle();
  click(root, "Sent last time");
  await settle();
  assert.equal(requests.filter((path) => path.includes("last-briefing")).length, 1);
  const shown = text(root);
  // The past view is the past view: no compiled projection bleeds into it.
  assert.match(shown, /has not run yet/);
  assert.doesNotMatch(shown, /A preview is not a send/);
  assert.doesNotMatch(shown, /Compiled prompt/);

  // Nothing in the past view offers to rebuild a preview: pressing it would
  // throw a person out of what they were reading.
  assert.equal(
    root.findAll((node) => node.type === "button").filter((node) => text(node).includes("Refresh")).length,
    0,
  );

  click(root, "Would send now");
  await settle();
  // And back, without compiling again: the edit has not changed.
  assert.equal(requests.filter((path) => path.includes("prompt-preview")).length, 1);
  assert.match(text(root), /Compiled prompt/);
});

test("a worker that reports no switches gets the weaker sentence, never an invented switch", () => {
  // `result` is what a worker from before the truthful preview serves. The
  // screen must not fill in a switch position: it would be inventing the one
  // fact this panel exists to show.
  const html = renderToStaticMarkup(<EffectivePromptPreviewResultView result={result} />);
  assert.match(html, /A preview is not a send/);
  assert.match(html, /examples built from each binding/);
  assert.match(html, /does not say which switches the profile applied/);
  assert.doesNotMatch(html, /This profile receives/);
});

/* ── What the worker now reports about the run this claims to be ───────── */

const truthful: EffectivePromptPreviewResponse = {
  ...result,
  issues: [],
  profile: { profileId: "acme-review", version: 4, name: "Review (sol/high)", applied: "selected" },
  context: { includeWorkflowData: false, includeRepositoryInstructions: false },
  unresolvedSources: [
    {
      kind: "data",
      reference: "planning.output.plan",
      message:
        '"planning.output.plan" is not guaranteed when this block runs, so a run stops here instead of calling the agent. The value in the prompt above is an example this screen made up.',
      atRun: "fails_the_run",
    },
    {
      kind: "slot",
      reference: "ticket.key",
      message: "Resolved when this block runs.",
      atRun: "filled_at_run",
    },
  ],
  notPreviewable: [
    { kind: "repository_memory", reason: "What earlier runs learned is added from the prepared workspace." },
  ],
};

test("a value that stops a run is louder than one that gets filled in", () => {
  const html = renderToStaticMarkup(<EffectivePromptPreviewResultView result={truthful} />);
  const stops = html.indexOf("A run would stop here");
  const atRun = html.indexOf("Resolved at runtime");
  // Both are shown, the fatal one first and under its own heading: a preview
  // that reads as green for a definition that dies on its first run is the
  // defect this contract exists to end.
  assert.ok(stops >= 0 && atRun > stops);
  assert.match(html, /an example this screen made up/);
  assert.match(html, /planning.output.plan/);
  assert.match(html, /ticket.key/);
});

test("the switches the profile applied are said, both of them, either way", () => {
  const html = renderToStaticMarkup(<EffectivePromptPreviewResultView result={truthful} />);
  assert.match(html, /Review \(sol\/high\) v4, the profile this block selects/);
  // "Not coming" rather than "not shown here": the difference the screen could
  // not say before.
  assert.match(html, /no workflow data/);
  assert.match(html, /not coming, here or on a run/);
  assert.doesNotMatch(html, /does not say which switches/);
});

test("a section only a run composes is named instead of silently absent", () => {
  const html = renderToStaticMarkup(<EffectivePromptPreviewResultView result={truthful} />);
  assert.match(html, /A run composes these, this screen cannot/);
  assert.match(html, /Repo memory/);
});

/**
 * The list is not a promise. An operator who read it as the whole difference
 * could not find the repository map, concluded it was not being sent, and went
 * off to change their catalog: it is in every real send, and this screen simply
 * cannot build it. The list grew once and will fall behind again; the sentence
 * that says so is the part that cannot.
 */
test("the list of what only a run composes never claims to be complete", () => {
  const html = renderToStaticMarkup(<EffectivePromptPreviewResultView result={truthful} />);
  assert.match(html, /Not a complete list, and it cannot be/);
  assert.match(html, /A section missing here is not a section a run leaves out/);
  // And it points at the one place that does show a whole send.
  assert.match(html, /Sent last time/);
});

test("a gap kind this build has no name for is shown as the worker spelled it", () => {
  // The read side is open (.claude/rules/agent-visibility.md): a dashboard
  // older than its worker must render a new kind rather than drop the line.
  const html = renderToStaticMarkup(
    <EffectivePromptPreviewResultView
      result={{
        ...truthful,
        notPreviewable: [{ kind: "something_new", reason: "Only a run has it." }],
      }}
    />,
  );
  assert.match(html, /something_new/);
  assert.match(html, /Only a run has it\./);
});

test("a profile that could not be resolved is never shown as somebody else's", () => {
  const html = renderToStaticMarkup(
    <EffectivePromptPreviewResultView result={{ ...truthful, profile: null }} />,
  );
  assert.match(html, /No Harness Profile applied/);
  assert.doesNotMatch(html, /Review \(sol\/high\)/);
});

test("a fate this build does not know is not read as harmless", () => {
  const html = renderToStaticMarkup(
    <EffectivePromptPreviewResultView
      result={{
        ...truthful,
        unresolvedSources: [
          { kind: "data", reference: "x.y", message: "Something a newer worker knows.", atRun: "retried_at_run" },
        ],
      }}
    />,
  );
  // Not claimed fatal (that would cry wolf) and not dressed up as resolved:
  // the worker's own sentence, with nothing added.
  assert.doesNotMatch(html, /A run would stop here/);
  assert.match(html, /Something a newer worker knows/);
});

test("everything wrong with this prompt sits together, above what is merely absent", () => {
  const html = renderToStaticMarkup(
    <EffectivePromptPreviewResultView result={{ ...truthful, issues: result.issues }} />,
  );
  const stops = html.indexOf("A run would stop here");
  const errors = html.indexOf("Preview errors");
  const caveat = html.indexOf("A preview is not a send");
  // A grey block between two red ones reads as two unrelated problems, and the
  // second one is the one that gets skipped.
  assert.ok(stops >= 0 && errors > stops && caveat > errors);
});
