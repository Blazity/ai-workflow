// apps/dashboard/components/cockpit/agent-visibility/repositories-panel.test.tsx
//
// This panel is where a person finds out what their answer in Jira did. The
// mistakes it must not make: hiding a question that is still waiting, losing
// arrivals of the same answer, showing "nothing here" when the read failed or
// when the worker is simply older than this dashboard, and claiming nobody
// answered a round whose answers predate delivery recording.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import {
  ANNA,
  FILIP,
  FIXTURE_TICKET,
  LEGACY,
  OLD_ADMIN,
  SHOP_API,
  SHOP_WEB,
  buildFixtureStore,
  serveFixture,
  type FixtureStore,
} from "@/lib/agent-visibility/test-support/fixtures";
import { installBrowser } from "@/lib/agent-visibility/test-support/browser";

import { IDLE_POLL_MS } from "@/lib/use-live-poll";

import { RepositoriesPanel, ticketSubjectKey } from "./repositories-panel";

// The primitives are transpiled to `React.createElement` here, with no import
// of their own; the runner has no bundler to provide it.
(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { self?: typeof globalThis }).self ??= globalThis;

let store: FixtureStore;
test.before(async () => {
  store = await buildFixtureStore();
});

function render(
  t: TestContext,
  options: {
    ticketKey?: string;
    fail?: { pattern: RegExp; status: number };
    /** An older worker: the record comes back without its rounds. */
    withoutRounds?: boolean;
    /** As the ticket's own view mounts it: a waiting question may open it. */
    autoOpen?: boolean;
  } = {},
): { root: ReactTestInstance; requests: string[] } {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string) => {
    const path = String(input);
    requests.push(path);
    if (options.fail?.pattern.test(path)) {
      return Promise.resolve(Response.json({ error: "on purpose" }, { status: options.fail.status }));
    }
    const asked = new URL(path, "http://dashboard.test");
    const served = serveFixture(
      store,
      "GET",
      new URL(`/api/v1${asked.pathname.slice("/api".length)}${asked.search}`, "http://worker.test"),
    );
    if (!served) return Promise.resolve(Response.json({ error: "not served" }, { status: 404 }));
    let body = served.body;
    if (options.withoutRounds && body && typeof body === "object" && "rounds" in body) {
      const { rounds: _rounds, ...rest } = body as Record<string, unknown>;
      body = rest;
    }
    return Promise.resolve(Response.json(body, { status: served.status }));
  }) as typeof globalThis.fetch;

  // A question is waiting in the fixtures, so the panel polls, and the poll
  // asks the document whether this tab is visible.
  const uninstallBrowser = installBrowser();
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <RepositoriesPanel ticketKey={options.ticketKey ?? FIXTURE_TICKET} autoOpen={options.autoOpen ?? true} />,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    uninstallBrowser();
    globalThis.fetch = originalFetch;
  });
  return { root: renderer.root, requests };
}

async function settle(times = 8) {
  for (let turn = 0; turn < times; turn += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function text(node: ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap((child) => child.children.filter((entry): entry is string => typeof entry === "string"))
    .join(" ")
    .replace(/\s+/g, " ");
}

function buttons(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll((node) => node.type === "button").filter((node) => text(node).includes(label));
}

async function openRound(root: ReactTestInstance, fragment: string) {
  const found = buttons(root, fragment).filter((node) => node.props["aria-expanded"] !== undefined);
  assert.ok(found.length > 0, `no round mentioning "${fragment}"`);
  act(() => found[0]!.props.onClick());
  await settle();
}

test("a ticket's record is read under the subject key the worker writes", async (t) => {
  const harness = render(t, { ticketKey: "awp-235" });
  await settle();
  assert.equal(ticketSubjectKey("awp-235"), "ticket:jira:AWP-235");
  assert.ok(
    harness.requests[0]?.includes(`subjectKey=${encodeURIComponent("ticket:jira:AWP-235")}`),
    `asked for ${harness.requests[0]}`,
  );
  // Rounds are opt-in on the worker, and this panel is the caller that wants
  // them: without the opt-in the record comes back without a single question.
  assert.ok(harness.requests[0]?.includes("rounds=true"), `asked for ${harness.requests[0]}`);
});

test("a question still waiting opens the panel and says so in its header", async (t) => {
  const harness = render(t);
  await settle();

  const body = text(harness.root);
  assert.match(body, /1 question waiting/);
  assert.match(body, /4 repositories decided, 4 questions/);
  // The waiting question is open, with the words that were asked.
  assert.match(body, /This run holds 11 repositories and may work on 3/);
  assert.match(body, /Nobody has answered this question yet/);
  assert.match(body, /the run held more repositories than it may work on/);
});

test("every entry says who decided it, when and why", async (t) => {
  const harness = render(t);
  await settle();

  const body = text(harness.root);
  assert.match(body, new RegExp(`${SHOP_WEB} Selected`));
  assert.match(body, new RegExp(`${FILIP} on 18 Sept 2026.*a person decided.*named in the answer to question 1`));
  assert.match(body, new RegExp(`${SHOP_API} Selected`));
  assert.match(body, new RegExp(`${ANNA} on `));
  assert.match(body, new RegExp(`${LEGACY} Excluded`));
  assert.match(body, new RegExp(`${OLD_ADMIN} Unavailable: not enabled`));
  assert.match(body, /the trigger's repository policy/);
  assert.match(body, /record version 4/);
});

test("a round shows each delivery: the words, who, where, how it was read and what we said back", async (t) => {
  const harness = render(t);
  await settle();
  await openRound(harness.root, "Which repository should AWP-235 change?");

  const body = text(harness.root);
  assert.match(body, /the web one probably/);
  assert.match(body, new RegExp(`${FILIP} · via Jira`));
  assert.match(body, /Unclear\. Best guess: "They may mean github:acme\/shop-web\."/);
  assert.match(body, /read by claude-haiku-4-5/);
  assert.match(body, /read without a model \(the provider could not be reached\)/);
  assert.match(body, /We posted back:/);
  assert.match(body, /I could not tell which repository you meant\. Did you mean github:acme\/shop-web\?/);
  assert.match(body, new RegExp(`Chose ${SHOP_WEB}\\.`));
  // The clear answer arrived five times and is one delivery, not five.
  assert.match(body, /arrived 5 times, first .*, last /);
  assert.match(body, /3 answers, 7 arrivals/);
  // And what the record did about it.
  assert.match(body, /The answer was taken/);
  assert.match(body, /The record was written/);
  assert.match(body, new RegExp(`${SHOP_WEB} is selected`));
});

test("hundreds of identical arrivals stay one answer, with a count and the last time", async (t) => {
  const harness = render(t);
  await settle();
  await openRound(harness.root, "Should this run use it after all?");

  const body = text(harness.root);
  assert.match(body, /arrived 300 times/);
  assert.match(body, /no, leave legacy out/);
  assert.match(body, /1 row of this round could not be read and is not shown/);
  assert.equal(buttons(harness.root, "Load more answers").length, 0);
});

test("a round answered before deliveries were recorded says that, not that nobody answered", async (t) => {
  const harness = render(t);
  await settle();
  await openRound(harness.root, "Which repository holds the payment widget?");

  const body = text(harness.root);
  assert.match(body, /answered before answer deliveries were recorded/);
  assert.match(body, /the words are on the ticket and not here/);
  assert.doesNotMatch(body, /Nobody has answered this question yet\. .*payment widget/);
});

test("a ticket nobody has decided anything for says exactly that", async (t) => {
  const harness = render(t, { ticketKey: "AWP-999" });
  await settle();
  act(() => buttons(harness.root, "Repositories")[0]!.props.onClick());
  await settle();

  const body = text(harness.root);
  assert.match(body, /No repository is decided for this ticket yet/);
  assert.match(body, /A run that needs one asks, and the answer lands here/);
  assert.match(body, /No repository question has been asked on this ticket/);
});

test("a worker too old to serve rounds says so instead of showing no questions", async (t) => {
  const harness = render(t, { withoutRounds: true });
  await settle();
  act(() => buttons(harness.root, "Repositories")[0]!.props.onClick());
  await settle();

  const body = text(harness.root);
  assert.match(body, /does not serve repository questions yet/);
  assert.doesNotMatch(body, /No repository question has been asked/);
  // The record itself is still there.
  assert.match(body, new RegExp(`${SHOP_WEB} Selected`));
});

test("a read that fails is told as a failure, with a way to try again", async (t) => {
  const harness = render(t, { fail: { pattern: /work-scope/, status: 503 } });
  await settle();
  act(() => buttons(harness.root, "Repositories")[0]!.props.onClick());
  await settle();

  const body = text(harness.root);
  assert.match(body, /The repository record could not be loaded: the worker answered 503/);
  assert.doesNotMatch(body, /No repository is decided for this ticket yet/);
  assert.equal(buttons(harness.root, "Retry").length, 1);
});

test("only the twin a person can see reads the record", async (t) => {
  // The ticket page mounts this panel twice, one per breakpoint. Both trees
  // are live, and the hidden one must not spend a request or a byte.
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string) => {
    const path = String(input);
    requests.push(path);
    const asked = new URL(path, "http://dashboard.test");
    const answer = serveFixture(
      store,
      "GET",
      new URL(`/api/v1${asked.pathname.slice("/api".length)}${asked.search}`, "http://worker.test"),
    );
    return Promise.resolve(
      answer
        ? Response.json(answer.body, { status: answer.status })
        : Response.json({ error: "not served" }, { status: 404 }),
    );
  }) as typeof globalThis.fetch;
  const uninstallBrowser = installBrowser();

  let panels = 0;
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <>
        <RepositoriesPanel ticketKey={FIXTURE_TICKET} autoOpen />
        <RepositoriesPanel ticketKey={FIXTURE_TICKET} autoOpen />
      </>,
      {
        createNodeMock: (element) => {
          if ((element.props as { "data-repositories-panel"?: string })["data-repositories-panel"]) {
            panels += 1;
            const visible = panels === 1;
            return { getClientRects: () => (visible ? [{ width: 900 }] : []) };
          }
          return { getClientRects: () => [{ width: 900 }], querySelector: () => null };
        },
      },
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    uninstallBrowser();
    globalThis.fetch = originalFetch;
  });
  await settle();

  assert.equal(panels, 2, "both twins mounted");
  assert.equal(
    requests.filter((path) => path.startsWith("/api/work-scope?")).length,
    1,
    `the record was read more than once: ${requests.join(" | ")}`,
  );
  assert.match(text(renderer.root), /1 question waiting/);
});

test("a page opened for one run keeps the record closed, and still says a question waits", async (t) => {
  const harness = render(t, { autoOpen: false });
  await settle();

  const body = text(harness.root);
  assert.match(body, /1 question waiting/);
  assert.match(body, /4 repositories decided, 4 questions/);
  // Closed: the trace below is what the person came for.
  assert.doesNotMatch(body, /What is decided/);
  assert.doesNotMatch(body, /This run holds 11 repositories/);

  act(() => buttons(harness.root, "Repositories")[0]!.props.onClick());
  await settle();
  assert.match(text(harness.root), /What is decided/);
});

test("a waiting question is polled, and the header says when this view was read", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const harness = render(t);
  await settle();
  const reads = () => harness.requests.filter((path) => path.startsWith("/api/work-scope?")).length;
  assert.equal(reads(), 1);
  assert.match(text(harness.root), /read at \d{2}:\d{2}/);

  await act(async () => {
    t.mock.timers.tick(IDLE_POLL_MS + 100);
    await Promise.resolve();
  });
  await settle();
  assert.ok(reads() > 1, "a waiting question is never read again, so an answer never shows");
});

test("an answered round with no kept words says that in its header", async (t) => {
  const harness = render(t);
  await settle();

  // Closed, as a person first sees it: "Answered" beside "no answer recorded"
  // is two contradictions in one line.
  const header = buttons(harness.root, "Which repository holds the payment widget?")[0]!;
  const summary = text(header);
  assert.match(summary, /Answered/);
  assert.match(summary, /answered before we kept the words/);
  assert.doesNotMatch(summary, /no answer recorded/);
});
