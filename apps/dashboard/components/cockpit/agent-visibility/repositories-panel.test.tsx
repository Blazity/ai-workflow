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
  DESIGN_SYSTEM,
  FILIP,
  FIXTURE_SUBJECT,
  FIXTURE_TICKET,
  LEGACY,
  OLD_ADMIN,
  SHOP_API,
  SHOP_MOBILE,
  SHOP_WEB,
  buildFixtureStore,
  resetFixtureScope,
  serveFixture,
  type FixtureStore,
} from "@/lib/agent-visibility/test-support/fixtures";
import { CALL_LLM_DEFAULT_MODEL } from "@shared/harness";
import { installBrowser } from "@/lib/agent-visibility/test-support/browser";

import { IDLE_POLL_MS } from "@/lib/use-live-poll";

import { RepositoriesPanel, panelTicketSubjectKey } from "./repositories-panel";

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
    /** The worker refusing every edit, as it refuses one. */
    refuseEdits?: { status: number; body: unknown };
  } = {},
): { root: ReactTestInstance; requests: string[]; edits: { body: unknown }[] } {
  const requests: string[] = [];
  const edits: { body: unknown }[] = [];
  resetFixtureScope(store);
  const originalFetch = globalThis.fetch;
  // The count belongs to this installation, not to the file: a test may end
  // while an answer is still on its way, and a count the next test had zeroed
  // would go negative when that answer lands, so nothing would ever look quiet
  // again. A leftover answer decrements the count of the test it belongs to,
  // where nobody is watching any more.
  const mine: Reads = { inFlight: 0, started: 0 };
  reads = mine;
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    requests.push(path);
    const sent = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    if (method !== "GET") edits.push({ body: sent });
    mine.inFlight += 1;
    mine.started += 1;
    // Every answer lands a turn later, the way a response does.
    const answer = async () => {
      const slow = Number(process.env.FIXTURE_SLOW_MS ?? 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(slow, 0)));
      if (options.refuseEdits && method !== "GET") {
        return Response.json(options.refuseEdits.body, { status: options.refuseEdits.status });
      }
      if (options.fail?.pattern.test(path)) {
        return Response.json({ error: "on purpose" }, { status: options.fail.status });
      }
      const asked = new URL(path, "http://dashboard.test");
      const served = serveFixture(
        store,
        method,
        new URL(`/api/v1${asked.pathname.slice("/api".length)}${asked.search}`, "http://worker.test"),
        sent,
      );
      if (!served) return Response.json({ error: "not served" }, { status: 404 });
      let body = served.body;
      if (options.withoutRounds && body && typeof body === "object" && "rounds" in body) {
        const { rounds: _rounds, ...rest } = body as Record<string, unknown>;
        body = rest;
      }
      return Response.json(body, { status: served.status });
    };
    return answer().finally(() => {
      mine.inFlight -= 1;
    });
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
  return { root: renderer.root, requests, edits };
}

/** What `settle` watches: the reads this panel has out, and how many it has
 *  started. One render per test, and this file's tests run one at a time. */
interface Reads {
  inFlight: number;
  started: number;
}
let reads: Reads = { inFlight: 0, started: 0 };

/** One turn of what a browser does between two paints: the microtasks a
 *  resolved promise queues, and the macrotask a fetch body lands on. */
async function turn() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Lets the chain of loads this panel starts finish, and waits for exactly
 * that: nothing in flight, and a turn that started nothing new, because a
 * read that lands usually starts the next one.
 *
 * NEVER A COUNT OF TURNS. How many turns a chain costs is the runner's
 * business, so a counted wait passes on an idle machine and returns mid-load
 * on a busy one, where the assertion then reads a half-built panel and the
 * failure looks like the product. `FIXTURE_SLOW_MS` delays every fixture
 * response by that many milliseconds, which is how this harness reproduces a
 * runner slow enough to break a counted wait.
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
  assert.equal(panelTicketSubjectKey("awp-235"), "ticket:jira:AWP-235");
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
  assert.match(body, /5 repositories decided, 4 questions/);
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
  // An entry the catalog's own edge wrote reads as that, not as a slug and not
  // as somebody's decision: it is the one entry a later run may withdraw by
  // itself, and a person deciding whether to keep it needs to know that.
  assert.match(body, new RegExp(`${DESIGN_SYSTEM} Selected`));
  assert.match(body, /the catalog relates it to a repository this work names/);
  assert.doesNotMatch(body, /related_repository/);
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
  assert.ok(body.includes(`read by ${CALL_LLM_DEFAULT_MODEL}`));
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
  assert.match(body, /5 repositories decided, 4 questions/);
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

/* ── Correcting the record ─────────────────────────────────────────────── */

function labelled(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAll((node) => node.type === "button" && node.props["aria-label"] === label);
  assert.equal(found.length, 1, `expected one control labelled "${label}", found ${found.length}`);
  return found[0]!;
}

async function click(node: ReactTestInstance) {
  act(() => node.props.onClick());
  await settle();
}

async function clickText(root: ReactTestInstance, label: string) {
  const found = buttons(root, label);
  assert.equal(found.length, 1, `expected one button saying "${label}", found ${found.length}`);
  await click(found[0]!);
}

test("an action is not a change: nothing is sent until the confirmation is tapped", async (t) => {
  const harness = render(t);
  await settle();

  await click(labelled(harness.root, `Exclude: ${SHOP_WEB}`));
  assert.deepEqual(harness.edits, [], "tapping an action wrote to the record");
  const asked = text(harness.root);
  assert.match(asked, new RegExp(`${SHOP_WEB} becomes a repository this ticket's work will not touch`));
  assert.match(asked, /It is recorded as your decision, with your name and the time/);
  assert.match(asked, /It changes the record only\. Nothing running is stopped or restarted by it/);
  // A question is waiting on this ticket, and this is not an answer to it.
  assert.match(asked, /This does not answer it, and the run stays parked/);

  await clickText(harness.root, "Cancel");
  assert.deepEqual(harness.edits, [], "cancelling wrote to the record");
  assert.doesNotMatch(text(harness.root), /becomes a repository this ticket's work will not touch/);
});

test("a confirmed change sends one change against the version that was read, and shows the worker's answer", async (t) => {
  const harness = render(t);
  await settle();

  await click(labelled(harness.root, `Exclude: ${SHOP_WEB}`));
  await clickText(harness.root, "Yes, exclude it");

  assert.deepEqual(harness.edits, [
    {
      body: {
        subjectKey: FIXTURE_SUBJECT,
        expectedVersion: 4,
        changes: [{ repositoryKey: SHOP_WEB, action: "exclude", rationale: "No reason given. Changed from the Repositories panel." }],
      },
    },
  ]);
  const body = text(harness.root);
  // The record on the screen is the one the worker sent back, version and all.
  assert.match(body, new RegExp(`${SHOP_WEB} Excluded`));
  assert.match(body, /record version 5/);
  assert.match(body, /Recorded\./);
  assert.match(body, new RegExp(`${SHOP_WEB} is now: excluded, ${FILIP}`));
  assert.match(body, /No reason given\. Changed from the Repositories panel/);
});

test("a person's own words are what the record keeps, when they write any", async (t) => {
  const harness = render(t);
  await settle();

  await click(labelled(harness.root, `Exclude: ${SHOP_WEB}`));
  await clickText(harness.root, "Add a reason");
  const field = harness.root.findAll(
    (node) => node.type === "input" && node.props["aria-label"] === "Why you are making this change",
  );
  assert.equal(field.length, 1);
  act(() => field[0]!.props.onChange({ target: { value: "I meant the API only." } }));
  await settle();
  await clickText(harness.root, "Yes, exclude it");

  assert.deepEqual((harness.edits[0]!.body as { changes: unknown[] }).changes, [
    { repositoryKey: SHOP_WEB, action: "exclude", rationale: "I meant the API only." },
  ]);
  assert.match(text(harness.root), /I meant the API only/);
});

test("undo puts the record back, and says so as one correction rather than a second decision", async (t) => {
  const harness = render(t);
  await settle();

  await click(labelled(harness.root, `Exclude: ${SHOP_WEB}`));
  await clickText(harness.root, "Yes, exclude it");
  assert.match(text(harness.root), new RegExp(`${SHOP_WEB} Excluded`));

  await clickText(harness.root, "Undo this change");
  // It says what putting it back means, including whose name ends up on it.
  const asked = text(harness.root);
  assert.match(asked, new RegExp(`${SHOP_WEB} goes back to selected, where it was before your change`));
  assert.match(asked, /Your name goes on it/);
  await clickText(harness.root, "Yes, select it");

  const body = text(harness.root);
  assert.match(body, new RegExp(`${SHOP_WEB} Selected`));
  assert.match(body, /Put back\./);
  assert.match(body, /record version 6/);
  // One correction: there is nothing to undo about an undo.
  assert.equal(buttons(harness.root, "Undo this change").length, 0);
  assert.equal(harness.edits.length, 2);
  assert.deepEqual(harness.edits[1]!.body, {
    subjectKey: FIXTURE_SUBJECT,
    expectedVersion: 5,
    changes: [{ repositoryKey: SHOP_WEB, action: "select", rationale: "No reason given. Changed from the Repositories panel." }],
  });
});

test("a repository a question offered and nobody decided about can be put in the record", async (t) => {
  const harness = render(t);
  await settle();

  const body = text(harness.root);
  assert.match(body, /Offered in a question, not in the record/);
  // The sentence explains the group and reads the same for every row in it, so
  // it is said once, between the heading and the keys. Per row it was the same
  // paragraph over and over, between a person and the keys they came to read.
  // Asserted as an order rather than as a count, because this fixture offers
  // one repository and a count of one cannot tell the two arrangements apart.
  assert.match(
    body,
    new RegExp(
      `Offered in a question, not in the record Not in the record, which is not the same as nobody deciding.*? ${SHOP_MOBILE} Select Exclude`,
    ),
  );
  // It may not claim nobody decided: answering "none of these" passes over
  // every candidate and leaves them all here, with no entry written for any.
  assert.doesNotMatch(body, /[Nn]obody decided about this one/);
  await click(labelled(harness.root, `Select: ${SHOP_MOBILE}`));
  await clickText(harness.root, "Yes, select it");

  const after = text(harness.root);
  assert.match(after, new RegExp(`${SHOP_MOBILE} Selected`));
  assert.match(after, /6 repositories decided/);
  // It is in the record now, so it is no longer offered as one nobody decided,
  // and it was the only one: the whole group goes with it rather than standing
  // there as a heading and an explanation above nothing.
  assert.doesNotMatch(after, new RegExp(`${SHOP_MOBILE} Select Exclude`));
  assert.doesNotMatch(after, /Offered in a question, not in the record/);
  // And it can be taken straight back out, where the undo lives.
  assert.equal(buttons(harness.root, "Undo this change").length, 1);
});

test("a repository the catalog does not enable is refused in the worker's own words", async (t) => {
  const harness = render(t);
  await settle();

  await click(labelled(harness.root, `Select: ${OLD_ADMIN}`));
  await clickText(harness.root, "Yes, select it");

  const body = text(harness.root);
  assert.match(body, /The change was refused/);
  assert.match(body, new RegExp(`The repository catalog does not enable ${OLD_ADMIN}`));
  assert.match(body, /Ask an owner or an admin to enable it on the Repositories page/);
  assert.match(body, /Nothing was changed/);
  // And the record is where it was.
  assert.match(body, new RegExp(`${OLD_ADMIN} Unavailable: not enabled`));
  assert.match(body, /record version 4/);
});

test("a person the worker does not accept is told in a sentence, not in a status code", async (t) => {
  const harness = render(t, {
    // Exactly what `requireDashboardActor` answers a non-member with.
    refuseEdits: { status: 403, body: { statusCode: 403, statusMessage: "Forbidden" } },
  });
  await settle();

  await click(labelled(harness.root, `Exclude: ${SHOP_WEB}`));
  await clickText(harness.root, "Yes, exclude it");

  const body = text(harness.root);
  assert.match(body, /The worker did not accept you as a member here/);
  assert.match(body, /every member of the workspace/);
  assert.match(body, /an owner or an admin adding you/);
  assert.doesNotMatch(body, /Forbidden/);
  assert.doesNotMatch(body, /403/);
  assert.match(body, new RegExp(`${SHOP_WEB} Selected`), "the record was not changed on the screen either");
});

test("an edit against a record that moved on is refused and says which versions", async (t) => {
  const harness = render(t, {
    refuseEdits: { status: 409, body: { error: "version_conflict", latestVersion: 9 } },
  });
  await settle();

  await click(labelled(harness.root, `Exclude: ${SHOP_WEB}`));
  await clickText(harness.root, "Yes, exclude it");

  const body = text(harness.root);
  assert.match(body, /The record moved while this page was open/);
  assert.match(body, /Nothing was changed/);
  assert.match(body, /version 4/);
  assert.match(body, /version 9/);
  assert.doesNotMatch(body, /version_conflict/);
  assert.match(body, new RegExp(`${SHOP_WEB} Selected`));
  assert.equal(buttons(harness.root, "Read the record again").length, 1);
});

test("a record that moves under an open confirmation stops the change before it is sent", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const harness = render(t);
  await settle();

  await click(labelled(harness.root, `Exclude: ${SHOP_WEB}`));
  // Another person writes while this one is deciding. The waiting question
  // makes this panel poll, so the new version arrives on its own.
  store.scope = { version: 9, entries: store.scope.entries };
  await act(async () => {
    t.mock.timers.tick(IDLE_POLL_MS + 100);
    await Promise.resolve();
  });
  await settle();

  const body = text(harness.root);
  assert.match(body, /The record changed while you were deciding/);
  assert.match(body, /Nothing was sent/);
  assert.match(body, /version 9/);
  assert.deepEqual(harness.edits, [], "a change was sent against a version nobody was looking at");
  assert.equal(buttons(harness.root, "Yes, exclude it").length, 0, "the confirmation stayed tappable");
});

test("removing an entry takes it out of the record, and the undo puts it back where it was", async (t) => {
  const harness = render(t);
  await settle();

  await click(labelled(harness.root, `Remove from the record: ${LEGACY}`));
  const asked = text(harness.root);
  assert.match(asked, new RegExp(`${LEGACY} leaves the record: neither chosen nor refused`));
  assert.match(asked, /A later run may ask about it again/);
  await clickText(harness.root, "Yes, remove it");

  const gone = text(harness.root);
  assert.match(gone, new RegExp(`${LEGACY} is not in the record`));
  assert.match(gone, /4 repositories decided/);
  assert.match(gone, /record version 5/);
  // The entry is gone from the list, and the notice that offers the undo is
  // not: it sits above the list for exactly this case.
  assert.doesNotMatch(gone, new RegExp(`${LEGACY} Excluded`));
  assert.deepEqual(harness.edits[0]!.body, {
    subjectKey: FIXTURE_SUBJECT,
    expectedVersion: 4,
    changes: [{ repositoryKey: LEGACY, action: "remove", rationale: "No reason given. Changed from the Repositories panel." }],
  });

  await clickText(harness.root, "Undo this change");
  assert.match(text(harness.root), new RegExp(`${LEGACY} goes back to excluded, where it was before your change`));
  await clickText(harness.root, "Yes, exclude it");

  const back = text(harness.root);
  assert.match(back, new RegExp(`${LEGACY} Excluded`));
  assert.match(back, /Put back\./);
  assert.match(back, /5 repositories decided/);
});

test("a repository a question offered can also be ruled out, not only chosen", async (t) => {
  const harness = render(t);
  await settle();

  assert.match(text(harness.root), /excluding it keeps a later question from offering it again/);
  await click(labelled(harness.root, `Exclude: ${SHOP_MOBILE}`));
  await clickText(harness.root, "Yes, exclude it");

  const body = text(harness.root);
  assert.match(body, new RegExp(`${SHOP_MOBILE} Excluded`));
  assert.deepEqual(harness.edits[0]!.body, {
    subjectKey: FIXTURE_SUBJECT,
    expectedVersion: 4,
    changes: [{ repositoryKey: SHOP_MOBILE, action: "exclude", rationale: "No reason given. Changed from the Repositories panel." }],
  });
});

test("a question the worker itself could not read is named, not silently missing", async (t) => {
  const harness = render(t);
  await settle();

  const body = text(harness.root);
  assert.match(body, /1 round could not be read and is not listed/);
  // The worker leaves such a row out of `total` as well, so the count of
  // questions stays the count of questions a person can actually open.
  assert.match(body, /5 repositories decided, 4 questions/);
});
