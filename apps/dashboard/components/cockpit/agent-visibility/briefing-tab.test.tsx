// apps/dashboard/components/cockpit/agent-visibility/briefing-tab.test.tsx
//
// The Briefing tab answers one question: what did this agent actually get? The
// mistakes that would make it lie are the ones here. Telling a person nothing
// was sent when the read merely failed. Losing a send behind the one before
// it. Showing text the cap cut as if the agent had read it. Blanking a send
// written by a newer worker. Refetching, and so resetting, what a person is
// reading.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import {
  ANNA,
  DESIGN_SYSTEM,
  EXPIRED_RUN,
  OLD_ADMIN,
  OLD_RUN,
  PAYMENTS,
  PLANNING_RUN,
  SECRET,
  SHOP_CMS,
  SHOP_SEARCH,
  SHOP_WEB,
  STATES_RUN,
  buildFixtureStore,
  serveFixture,
  type FixtureStore,
} from "@/lib/agent-visibility/test-support/fixtures";
import { DEFAULT_MODELS } from "@shared/harness";
import { installBrowser } from "@/lib/agent-visibility/test-support/browser";

import { LIVE_POLL_MS } from "@/lib/use-live-poll";

import { BriefingTab, type BriefingAttempt } from "./briefing-tab";
import { PagedCacheProvider } from "./paged";

// The primitives are transpiled to `React.createElement` here, with no import
// of their own; the runner has no bundler to provide it.
(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { self?: typeof globalThis }).self ??= globalThis;

let store: FixtureStore;
test.before(async () => {
  store = await buildFixtureStore();
});

const attemptOf = (nodeId: string): BriefingAttempt => ({
  nodeId,
  attempt: 1,
  activationScopeId: "root",
  live: false,
});

interface Harness {
  root: ReactTestInstance;
  /** Every dashboard path asked for, in order. */
  requests: string[];
}

/** What `settle` watches: the reads this screen has out, and how many it has
 *  started, so a turn that started another one is not mistaken for quiet.
 *  One render per test, and this file's tests run one at a time. */
interface Reads {
  inFlight: number;
  started: number;
}
let reads: Reads = { inFlight: 0, started: 0 };

/** The tab with the link state its screen holds, over a fetch that answers
 *  from the fixtures the way the proxy would. */
function Screen({
  runId,
  attempt,
  runIsLive,
  send,
  section,
}: {
  runId: string;
  attempt: BriefingAttempt;
  runIsLive: boolean;
  send: string | null;
  section: string | null;
}) {
  const [link, setLink] = React.useState<{ send: string | null; section: string | null }>({
    send,
    section,
  });
  return (
    <PagedCacheProvider>
      <BriefingTab
        runId={runId}
        attempt={attempt}
        runIsLive={runIsLive}
        send={link.send}
        section={link.section}
        onLinkChange={(patch) => setLink((current) => ({ ...current, ...patch }))}
      />
    </PagedCacheProvider>
  );
}

function render(
  t: TestContext,
  options: {
    runId?: string;
    node?: string;
    runIsLive?: boolean;
    /** The send the link names, as a briefing id. */
    send?: string;
    /** The section the link names, by index, `map` or `sources`. */
    section?: string;
    /** Paths matching this answer with `status` instead of the fixtures. */
    fail?: { pattern: RegExp; status: number };
  } = {},
): Harness {
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
      if (options.fail?.pattern.test(path)) {
        return Response.json({ error: "on purpose" }, { status: options.fail.status });
      }
      const asked = new URL(path, "http://dashboard.test");
      // The proxy forwards `/api/...` to the worker's `/api/v1/...`.
      const served = serveFixture(
        store,
        "GET",
        new URL(`/api/v1${asked.pathname.slice("/api".length)}${asked.search}`, "http://worker.test"),
      );
      if (!served) return Response.json({ error: "not served" }, { status: 404 });
      return Response.json(served.body, { status: served.status });
    };
    return answer().finally(() => {
      mine.inFlight -= 1;
    });
  }) as typeof globalThis.fetch;

  // A live run polls, and the poll needs a document to ask whether the tab is
  // visible.
  const uninstallBrowser = options.runIsLive ? installBrowser() : () => {};
  let renderer!: ReturnType<typeof create>;
  const attempt = { ...attemptOf(options.node ?? "planning"), live: options.runIsLive ?? false };
  act(() => {
    renderer = create(
      <Screen
        runId={options.runId ?? PLANNING_RUN}
        attempt={attempt}
        runIsLive={options.runIsLive ?? false}
        send={options.send ?? null}
        section={options.section ?? null}
      />,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    uninstallBrowser();
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
 * Lets the chain of loads a screen starts finish, and waits for exactly that.
 *
 * NEVER A COUNT OF TURNS. A screen here loads in chains (sends, then sections,
 * then the first page of text and the part list), each hop a fetch whose body
 * lands a turn or more after the call. How many turns that costs is the
 * runner's business, so a fixed count passes on an idle machine and, on a
 * loaded one, returns while five section reads are still in flight: the
 * assertion then reads an idle screen and the failure looks like the product.
 * Quiet is the condition those assertions mean, and it is two things, because
 * a read that lands usually starts the next one: nothing in flight, and a
 * turn that started nothing new.
 *
 * The bound is wall clock, so a slower machine waits longer instead of
 * failing, and a screen that never settles fails as a readable timeout rather
 * than hanging the suite. `FIXTURE_SLOW_MS` delays every fixture response by
 * that many milliseconds, which is how this harness reproduces a runner slow
 * enough to break a counted wait.
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
      assert.fail(`the screen was still loading after ${timeoutMs} ms: ${reads.inFlight} request(s) in flight`);
    }
  }
}

/**
 * Waits for the thing the next assertion is about, and fails with what the
 * screen showed instead. For a state a person reaches through work the screen
 * does after its reads land, where "nothing in flight" is true too early.
 */
async function waitForText(root: ReactTestInstance, expected: RegExp, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = text(root);
    if (expected.test(seen)) return seen;
    if (Date.now() >= deadline) {
      assert.fail(`waited ${timeoutMs} ms for ${expected}, and the screen showed: ${seen.slice(0, 900)}`);
    }
    await turn();
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

function click(root: ReactTestInstance, label: string) {
  const found = buttons(root, label);
  assert.equal(found.length, 1, `expected exactly one button containing "${label}", found ${found.length}`);
  act(() => found[0]!.props.onClick());
}

/** The send picker, in the order the sends went out. */
function sendButtons(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((node) => node.type === "button" && node.props["aria-pressed"] !== undefined);
}

function clickSend(root: ReactTestInstance, position: number) {
  const found = sendButtons(root)[position - 1];
  assert.ok(found, `there is no send ${position}`);
  act(() => found.props.onClick());
}

/** What the model read is bigger than one page; this is the person asking for
 *  the whole of it. */
async function loadTheRest(root: ReactTestInstance) {
  for (let turn = 0; turn < 4 && buttons(root, "Load the rest").length > 0; turn += 1) {
    click(root, "Load the rest");
    await settle();
  }
}

test("every send of the attempt is listed in the order it went out", async (t) => {
  const harness = render(t);
  await settle();

  const labels = sendButtons(harness.root).map((node) => text(node));
  assert.deepEqual(
    labels.map((label) => label.replace(/ \d{1,2} \w+ \d{4}.*$/, "").trim()),
    [
      "1. Repository discovery",
      "2. Agent pass",
      "3. Agent pass: expansion round 1",
      "4. Agent pass: expansion closed",
    ],
  );
  // The last send is what a person came to read, and it opens itself.
  assert.match(text(harness.root), /send 4/);
});

test("the run data section opens with each part attributed to where it came from", async (t) => {
  const harness = render(t);
  await settle();
  // The ticket description alone is longer than a page, so the parts after it
  // arrive when a person asks for the rest.
  await loadTheRest(harness.root);

  const body = text(harness.root);
  assert.match(body, /Ticket comment by Anna Kowalska/);
  assert.match(body, new RegExp(`${ANNA}: reproduced on Safari`));
  assert.match(body, /Clarification answer round 2, by Filip Maszota/);

  // Our own rules are marked as ours, and nothing else is.
  const ours = harness.root.findAll((node) => node.props["data-origin"] === "ours");
  assert.deepEqual(ours.map((node) => node.props["data-part-id"]).sort(), [
    "expansion-closed-guidance",
    "refused-requests-guidance",
    "repository-access-protocol",
  ]);
  const ticketRow = harness.root.find((node) => node.props["data-part-id"] === "comment:1");
  assert.equal(ticketRow.props["data-origin"], "ticket_comment");
});

test("what the cap cut reads differently from what our storage trimmed", async (t) => {
  const harness = render(t);
  await settle();

  const body = text(harness.root);
  assert.match(body, /What the agent did not get/);
  assert.match(body, /Removed whole by the 200,000 character section cap\. The agent never got this part/);
  assert.match(body, /The agent got only the text shown here/);

  // The AGENTS.md section is the one our budget cut, and it says the agent got
  // all of it.
  click(harness.root, "AGENTS.md");
  await settle();
  const trimmed = text(harness.root);
  assert.match(trimmed, /our storage budget kept the first/);
  assert.match(trimmed, /Nothing after that point is shown here/);
  assert.doesNotMatch(trimmed, /never got this part.*AGENTS\.md/);
});

test("a rule withheld on purpose says so where the pass that withheld it is open", async (t) => {
  const harness = render(t);
  await settle();

  clickSend(harness.root, 2);
  await settle();
  await loadTheRest(harness.root);

  const body = text(harness.root);
  assert.match(body, /Withheld on purpose/);
  assert.match(body, /Not sent, deliberately \(the pull request carries review feedback\)/);
  assert.match(body, /the already-resolved exit is not offered/);
});

test("a secret in the ticket is shown as removed, not as the secret", async (t) => {
  const harness = render(t);
  await settle();

  const body = text(harness.root);
  assert.doesNotMatch(body, new RegExp(SECRET));
  const marks = harness.root.findAll((node) => node.type === "mark");
  assert.ok(marks.length > 0, "the redaction marker is not on the screen");
  assert.ok(
    marks.some((mark) => String(mark.props["data-redaction"]) === "token"),
    "the token redaction is not marked as one",
  );
});

test("the harness facts say what else went with the prompt", async (t) => {
  const harness = render(t);
  await settle();
  // The first pass is the one whose AGENTS.md could not be read.
  clickSend(harness.root, 2);
  await settle();

  const body = text(harness.root);
  assert.ok(body.includes(DEFAULT_MODELS.claude));
  assert.match(body, /Skills delivered \(1\) repository-map-check v2/);
  assert.match(body, /Run data in this prompt included/);
  assert.match(body, /Sources the compiler could not resolve/);
});

test("a discovery send and a pass that never went out are told apart", async (t) => {
  const harness = render(t, { runId: STATES_RUN, node: "planning" });
  await settle();

  const body = text(harness.root);
  assert.equal(sendButtons(harness.root).length, 1);
  assert.match(text(sendButtons(harness.root)[0]!), /Repository discovery/);
  assert.match(body, /The next send has not gone out yet/);
  assert.match(body, /still preparing its prompt/);
});

test("a block that sends no prompt says so instead of looking broken", async (t) => {
  const harness = render(t, { node: "trigger" });
  await settle();

  const body = text(harness.root);
  assert.match(body, /No prompt goes out from this block/);
  assert.doesNotMatch(body, /Not recorded/);
});

test("an attempt that failed before sending says what failed", async (t) => {
  const harness = render(t, { node: "implementation" });
  await settle();

  const body = text(harness.root);
  assert.match(body, /Never sent/);
  assert.match(body, /failed before its prompt went out, so the agent got nothing/);
  assert.match(body, /sandbox: The sandbox stopped responding while the workspace was prepared\./);
});

test("a read that fails is never told as a missing briefing", async (t) => {
  const harness = render(t, { fail: { pattern: /\/briefings\?/, status: 404 } });
  await settle();

  const body = text(harness.root);
  assert.match(body, /Briefings could not be loaded/);
  assert.match(body, /A worker older than this dashboard does not serve them yet/);
  assert.doesNotMatch(body, /Never sent|Not recorded|Not sent yet/);
  assert.equal(buttons(harness.root, "Retry").length, 1);
});

test("an unreadable record never swallows the readable send beside it", async (t) => {
  // This attempt holds a record written by a newer worker and a readable
  // `call_llm` send. The unreadable one carries no send number of its own, so
  // the link is keyed by briefing id: a made-up number would name the other
  // send and make the readable one unreachable.
  const harness = render(t, { runId: STATES_RUN, node: "research" });
  await settle();

  const picker = sendButtons(harness.root).map((node) => text(node));
  assert.match(picker[0]!, /Could not be read written by a newer AI Workflow/);
  // The number a person reads in the list is the worker's own send number, the
  // same one the panel prints below.
  assert.match(picker[1]!, /1\. Model call/);

  clickSend(harness.root, 2);
  await settle();
  const readable = text(harness.root);
  assert.match(readable, /Model call send 1/);
  assert.match(readable, /System prompt/);
  assert.doesNotMatch(readable, /written by a newer version of AI Workflow/);

  clickSend(harness.root, 1);
  await settle();
  const unreadable = text(harness.root);
  assert.match(unreadable, /written by a newer version of AI Workflow \(schema version 2\)/);
  assert.match(unreadable, /briefing brf_states_newer/);
});

test("a link to a send that is gone says so instead of showing another one", async (t) => {
  const harness = render(t, { send: "brf_gone" });
  await settle();

  const body = text(harness.root);
  assert.match(body, /The send this link names is gone/);
  assert.match(body, /Briefings are kept as long as the run's replay is/);
  // And it still shows something useful: the latest send of the attempt.
  assert.match(body, /Agent pass: expansion closed/);
});

test("switching pass and back keeps what was loaded, and asks for nothing twice", async (t) => {
  const harness = render(t);
  await settle();
  const before = harness.requests.filter((path) => path.includes("/sections/")).length;
  assert.ok(before > 0, "nothing was loaded to keep");

  clickSend(harness.root, 2);
  await settle();
  const middle = harness.requests.filter((path) => path.includes("/sections/")).length;
  assert.ok(middle > before, "the other pass loaded nothing");

  clickSend(harness.root, 4);
  await settle();
  assert.equal(
    harness.requests.filter((path) => path.includes("/sections/")).length,
    middle,
    "coming back refetched what was already loaded",
  );
  assert.match(text(harness.root), /send 4/);
});

test("the repository map leads to the place in the prompt where the agent read it", async (t) => {
  const harness = render(t);
  await settle();

  click(harness.root, "Repositories the agent was told about");
  await settle();
  const map = text(harness.root);
  assert.match(map, /9 repositories described to the agent.*12 more repositories summarized as a count/);
  assert.match(map, /is a frontend for github:acme\/shop-api/);
  // Each repository as the agent read it: why it is there, whose description,
  // and the ones it may not touch.
  assert.match(map, /The ticket or event names it/);
  assert.match(map, new RegExp(`Related: ${SHOP_WEB} depends on a package published from this repository`));
  assert.match(map, /THE PROVIDER'S LISTING TEXT; THE CATALOG HAS NO DESCRIPTION|The provider's listing text; the catalog has no description/i);
  assert.match(map, /github:acme\/legacy-checkout.*Excluded/);
  // The switch on the Repositories page, and the entry that speaks before it:
  // a key the record calls unavailable can never read as the catalog switch.
  assert.match(map, new RegExp(`${SHOP_CMS} Disabled`));
  assert.match(map, new RegExp(`${SHOP_CMS} is switched off on the Repositories page`));
  assert.match(map, new RegExp(`${OLD_ADMIN} Not enabled`));
  assert.match(map, new RegExp(`Nobody has enabled ${OLD_ADMIN} on the Repositories page`));
  // Every closed door this build knows says which door it is, in words. A raw
  // slug here sends a person to the Repositories page for a state that page
  // cannot change, or looking for a decision nobody made.
  assert.match(map, new RegExp(`${SHOP_SEARCH} Nothing to check out`));
  assert.match(map, /the provider offers nothing this run could check out for it/);
  assert.match(map, new RegExp(`${PAYMENTS} Refused for this run`));
  assert.match(map, new RegExp(`This run already refused a request for ${PAYMENTS}`));
  assert.doesNotMatch(map, /\bunusable\b/);
  // The record entry the catalog's own edge wrote, told apart from a person's
  // decision and from a guess.
  assert.match(map, new RegExp(`${DESIGN_SYSTEM} Read only`));
  assert.match(map, /the catalog relates it to a repository this work names/);
  assert.doesNotMatch(map, /related_repository/);
  // Why it is listed is not a claim about its state.
  assert.match(map, /It is listed in the catalog/);
  assert.doesNotMatch(map, /in the enabled catalog/);
  assert.match(map, /Repository record version 4.*1 repository a person left out/);

  // The map is text in the prompt, and this is the way back to it: the run
  // data section opens on the part that held it, however far in it sits.
  click(harness.root, "Show the map as the agent read it");
  await settle();
  await waitForText(harness.root, /Selected Repositories/);
  const row = harness.root.find((node) => node.props["data-part-id"] === "selected-repositories");
  assert.match(String(row.props.className), /bg-mariner-700\/15/);
  assert.match(text(row), /Selected Repositories/);
});

test("a live run polling for later sends leaves what a person is reading alone", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const harness = render(t, { runIsLive: true });
  await settle();

  // A person opens a section that is not the one that opened itself.
  click(harness.root, "AGENTS.md");
  await settle();
  const reads = () => harness.requests.filter((path) => path.includes("/sections/1")).length;
  const before = reads();
  assert.ok(before > 0, "the section a person opened never loaded");
  const sends = harness.requests.filter((path) => path.includes("/briefings?")).length;

  await act(async () => {
    t.mock.timers.tick(LIVE_POLL_MS + 100);
    await Promise.resolve();
  });
  await settle();

  assert.ok(
    harness.requests.filter((path) => path.includes("/briefings?")).length > sends,
    "the tab did not poll for later sends",
  );
  assert.equal(reads(), before, "the poll reloaded the section a person was reading");
  assert.match(text(harness.root), /our storage budget kept the first/);
});

test("only the twin a person can see fetches anything", async (t) => {
  // The ticket page mounts this tab twice, one per breakpoint, and hides one
  // with CSS. Both trees are live: without the guard a phone downloads the
  // desktop tree's briefings as well, and every byte is paid twice.
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

  let frames = 0;
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <>
        <Screen runId={PLANNING_RUN} attempt={attemptOf("planning")} runIsLive={false} send={null} section={null} />
        <Screen runId={PLANNING_RUN} attempt={attemptOf("planning")} runIsLive={false} send={null} section={null} />
      </>,
      {
        createNodeMock: (element) => {
          // The first frame is the one on screen; the second is the twin CSS
          // hides, and a hidden element has no client rects.
          if ((element.props as { "data-briefing-frame"?: string })["data-briefing-frame"]) {
            frames += 1;
            const visible = frames === 1;
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

  assert.equal(frames, 2, "both twins mounted");
  assert.equal(
    requests.filter((path) => path.includes("/briefings?")).length,
    1,
    `the attempt was asked for more than once: ${requests.join(" | ")}`,
  );
  const byPath = new Set(requests);
  assert.equal(byPath.size, requests.length, `something was fetched twice: ${requests.join(" | ")}`);
  // And the twin a person sees still shows the send.
  assert.match(text(renderer.root), /Agent pass: expansion closed/);
});

test("a text read that fails says nothing about what the record holds", async (t) => {
  // The header says 73.8 KB and 21 parts. Saying "this section kept no text"
  // over a failed read turns a phone in a lift into a fact about the record.
  const harness = render(t, { fail: { pattern: /\/sections\/4\?offset=/, status: 503 } });
  await settle();

  const body = text(harness.root);
  assert.doesNotMatch(body, /This section kept no text/);
  assert.match(body, /This section's text could not be loaded: the worker answered 503/);
  assert.match(body, /73\.8 KB sent/);
  assert.ok(buttons(harness.root, "Retry").length > 0, "there is no way to try the text again");
});

test("a link to a section that is gone says so and opens the run data", async (t) => {
  const harness = render(t, { section: "999" });
  await settle();

  const body = text(harness.root);
  assert.match(body, /The section this link names is not in this send/);
  assert.match(body, /Showing this send's run data instead/);
  assert.match(body, /Run data : 73\.8 KB sent/);
});

test("the whole prompt copies as the bytes of every section, in order", async (t) => {
  const written: string[] = [];
  const previousNavigator = (globalThis as { navigator?: unknown }).navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: (value: string) => { written.push(value); return Promise.resolve(); } } },
    configurable: true,
  });
  t.after(() => {
    if (previousNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, "navigator", { value: previousNavigator, configurable: true });
  });

  const harness = render(t);
  await settle();
  assert.match(text(harness.root), /Step 1 of 2: 5 sections to load and check/);

  // Preparing reads the five sections whole, so the state this asserts exists
  // only once every one of them has landed: wait for it, never for a count.
  click(harness.root, "Prepare the whole prompt to copy");
  await waitForText(harness.root, /5 sections joined in order, each checked against the stored bytes/);

  // This send's budget trimmed a section, so the button says what it copies
  // rather than calling it the whole prompt.
  click(harness.root, "Copy what we kept");
  await settle();
  assert.equal(written.length, 1);
  const kept = store
    .briefings.get("brf_plan_4")!
    .sections.reduce((total, section) => total + section.storedBytes, 0);
  assert.equal(new TextEncoder().encode(written[0]!).length, kept);
  assert.match(text(harness.root), /Every section matched the length and sha256 the worker stored/);
});

/**
 * THE CAVEAT OUTLIVES THE CLICK.
 *
 * It used to be written only in the idle state, so it disappeared at the
 * moment a person reached the clipboard: they pressed the button and were told
 * every section matched the length and sha256 the worker stored, which is true
 * and reads as "this is all of it". Nobody may reach the clipboard without
 * knowing what is not in it.
 */
test("a send the budget trimmed says so in every state of the whole-prompt copy", async (t) => {
  const written: string[] = [];
  const previousNavigator = (globalThis as { navigator?: unknown }).navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: (value: string) => { written.push(value); return Promise.resolve(); } } },
    configurable: true,
  });
  t.after(() => {
    if (previousNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, "navigator", { value: previousNavigator, configurable: true });
  });

  const shortfall = /One section is here only in part: this copy is [\d.]+ KB of the [\d.]+ KB the agent read/;
  const harness = render(t);
  await settle();
  assert.match(text(harness.root), shortfall);

  // The caveat is on the idle screen too, so waiting for it would prove
  // nothing: wait for the prepared state, then read the caveat off it.
  click(harness.root, "Prepare the whole prompt to copy");
  await waitForText(harness.root, /Copy what we kept/);
  assert.match(text(harness.root), shortfall);
  // And the button itself never claims to be copying the whole prompt.
  assert.doesNotMatch(text(harness.root), /Copy the whole prompt/);

  click(harness.root, "Copy what we kept");
  await settle();
  assert.equal(written.length, 1);
  assert.match(text(harness.root), shortfall);
});

test("a run past its retention says we kept it and retention removed it", async (t) => {
  // No attempts and no briefings at all: an empty list on its own would read
  // as "the system lost it".
  const harness = render(t, { runId: EXPIRED_RUN, node: "planning" });
  await settle();

  const body = text(harness.root);
  assert.match(body, /These briefings expired/);
  assert.match(body, /recorded and kept with the run's replay, then removed when its retention ran out/);
  assert.doesNotMatch(body, /No record of this attempt/);
});

test("a block whose definition is gone says nobody can tell, not that it sends nothing", async (t) => {
  const harness = render(t, { runId: STATES_RUN, node: "investigate" });
  await settle();

  const body = text(harness.root);
  assert.match(body, /Whether this block sends a prompt is no longer known/);
  assert.match(body, /cannot say whether this block ever sends a prompt/);
  assert.doesNotMatch(body, /No prompt goes out from this block/);
  // The reason the worker recorded for the attempt is still there.
  assert.match(body, /Expired/);
});

test("an attempt says which turn of its loop it is and when it began", async (t) => {
  const harness = render(t, { runId: STATES_RUN, node: "fix" });
  await settle();

  const body = text(harness.root);
  // Both values as the worker read them off the activation scope, and no
  // invented total: nothing here knows how many turns the loop ran.
  assert.match(body, /loop fix-loop, iteration 3/);
  assert.doesNotMatch(body, /of 50/);
  assert.match(body, /started 19 Sept 2026, \d{2}:33:00/);
});

test("a run older than briefings says so once, not once per attempt", async (t) => {
  // Its replay is still here, so the Block Attempt opens and has to explain
  // itself: the run's own state is the explanation, and repeating it under
  // the attempt would be two sentences for one fact.
  const harness = render(t, { runId: OLD_RUN, node: "planning" });
  await settle();

  const body = text(harness.root);
  assert.match(body, /This run predates briefings/);
  assert.match(body, /before AI Workflow recorded what agents are sent/);
  assert.equal(body.match(/before AI Workflow recorded what agents are sent/g)?.length, 1);
  assert.doesNotMatch(body, /Not recorded/);
});

test("what capture refused to record is on the run's own screen, not only in the editor", async (t) => {
  // The same counters the flow editor shows: a refused capture is invisible
  // until somebody opens the one briefing that is not in the list, so both
  // screens that list sends have to carry it.
  const { root } = render(t, { runId: STATES_RUN, node: "research" });
  await settle();
  const shown = text(root);
  assert.match(shown, /7 sends/);
  assert.match(shown, /2 refused/);
  assert.match(shown, /1 lost/);
});
