// apps/dashboard/app/(cockpit)/repositories/suggestion-panel.test.tsx
//
// The states of asking a model to read a repository: the proposal shown beside
// what the repository declares today, a timeout, and an answer the screen
// cannot read. The rule under all three is that nothing here ever fills in a
// form: a proposal is something to accept one group at a time, into a draft the
// admin still saves with a reason.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import type {
  PrePrCheckRepositoryConfig,
  RepositoryCatalogSuggestResponse,
} from "@shared/contracts";

import { SuggestionPanel } from "./suggestion-panel";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CURRENT: PrePrCheckRepositoryConfig = {
  provider: "github",
  repoPath: "acme/web",
  groups: { checks: { commands: ["pnpm test"] } },
};

function proposal(
  overrides: Partial<RepositoryCatalogSuggestResponse> = {},
): RepositoryCatalogSuggestResponse {
  return {
    proposal: {
      source: "suggested",
      description: "A storefront built on Next.js.",
      rules: "Never touch the generated client.",
      scriptGroups: [
        { name: "checks", commands: ["pnpm test", "pnpm typecheck"], provenance: "model" },
        { name: "lint", commands: ["pnpm lint"], provenance: "model" },
      ],
    },
    droppedGroups: [],
    model: "claude-sonnet-4",
    usage: { inputTokens: 1200, outputTokens: 300 },
    costUsd: 0.02,
    ...overrides,
  } as RepositoryCatalogSuggestResponse;
}

interface Harness {
  root: ReactTestInstance;
  accepted: () => PrePrCheckRepositoryConfig[];
  descriptions: () => string[];
  calls: () => number;
}

/** Mounts the panel over a queue of answers to `POST suggest`, one per click. */
function render(
  t: TestContext,
  responses: Array<() => Response>,
  options: {
    current?: PrePrCheckRepositoryConfig | null;
    repository?: { provider: "github" | "gitlab"; path: string };
    description?: string;
    rules?: string;
  } = {},
): Harness {
  const queue = [...responses];
  let calls = 0;
  // The count belongs to this installation, not to the file: a test may end
  // while an answer is still on its way, and a count the next test had zeroed
  // would go negative when that answer lands, so nothing would ever look quiet
  // again. A leftover answer decrements the count of the test it belongs to,
  // where nobody is watching any more.
  const mine: Reads = { inFlight: 0, started: 0 };
  reads = mine;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    assert.equal(String(url), "/api/repository-catalog/suggest");
    calls += 1;
    const next = queue.shift();
    assert.ok(next, "an unexpected extra suggestion was asked for");
    mine.inFlight += 1;
    mine.started += 1;
    // Every answer lands a turn later, the way a response does: resolving in
    // the caller's own microtask is what let a counted wait look reliable.
    const answer = async () => {
      const slow = Number(process.env.FIXTURE_SLOW_MS ?? 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(slow, 0)));
      return next();
    };
    return answer().finally(() => {
      mine.inFlight -= 1;
    });
  }) as typeof globalThis.fetch;

  const accepted: PrePrCheckRepositoryConfig[] = [];
  const descriptions: string[] = [];
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <SuggestionPanel
        repositoryId={7}
        repository={options.repository ?? { provider: "github", path: "acme/web" }}
        currentEntry={options.current === undefined ? CURRENT : options.current}
        currentDescription={options.description ?? "The storefront, written by hand."}
        currentRules={options.rules ?? "Never touch the generated client by hand."}
        onUseDescription={(value) => descriptions.push(value)}
        onUseRules={() => {}}
        onAcceptGroups={(next) => accepted.push(next)}
      />,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  });
  return {
    root: renderer.root,
    accepted: () => accepted,
    descriptions: () => descriptions,
    calls: () => calls,
  };
}

/** What `settle` watches: the calls this file has out, and how many it has
 *  started, so a turn that started another one is not mistaken for quiet.
 *  One render per test, and this file's tests run one at a time. */
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
 * Lets the chain of calls this panel starts finish, and waits for exactly
 * that.
 *
 * NEVER A COUNT OF TURNS. How many turns a chain costs is the runner's
 * business, so a fixed count passes on an idle machine and, on a loaded one,
 * returns while calls are still in flight: the assertion then reads a waiting
 * screen and the failure looks like the product. Quiet is the condition those
 * assertions mean, and it is two things, because an answer that lands may
 * start the next call (the one automatic retry): nothing in flight, and a turn
 * that started nothing new.
 *
 * The bound is wall clock, so a slower machine waits longer instead of
 * failing, and a screen that never settles fails as a readable timeout rather
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
      assert.fail(`the screen was still loading after ${timeoutMs} ms: ${reads.inFlight} request(s) in flight`);
    }
  }
}

function text(node: ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap((child) => child.children.filter((c) => typeof c === "string"))
    .join(" ");
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const matches = root
    .findAll((node) => node.type === "button")
    .filter((node) => text(node).includes(label));
  assert.equal(matches.length, 1, `expected exactly one button containing "${label}"`);
  return matches[0];
}

async function ask(harness: Harness, label = "Suggest from repository") {
  act(() => {
    button(harness.root, label).props.onClick();
  });
  await settle();
}

test("a proposal is shown beside what the repository declares today, one tick per group", async (t) => {
  const harness = render(t, [() => Response.json(proposal())]);
  await ask(harness);
  const rendered = text(harness.root);

  // Side by side, verbatim: an admin accepting a group is accepting these exact
  // lines, so both sides are on screen before a tick is possible.
  assert.match(rendered, /Now/);
  assert.match(rendered, /Proposed/);
  assert.match(rendered, /1 \.  pnpm test/);
  assert.match(rendered, /2 \.  pnpm typecheck/);
  assert.match(rendered, /A storefront built on Next\.js\./);

  // Generated by a model, and the commands run in the sandbox checks: both
  // facts, before the command list rather than after it.
  assert.match(rendered, /Generated from this repository's own files by a model/);
  assert.match(rendered, /read every command before saving/);

  // One tick per group and no "use all".
  const ticks = harness.root.findAll(
    (node) => node.type === "input" && node.props.type === "checkbox",
  );
  assert.equal(ticks.length, 2);
  assert.doesNotMatch(rendered, /Use all/i);
  assert.doesNotMatch(rendered, /Accept all/i);
});

test("accepting a group hands it to the Scripts draft, and saves nothing by itself", async (t) => {
  const harness = render(t, [() => Response.json(proposal())]);
  await ask(harness);

  const move = () => button(harness.root, "into the Scripts draft");
  assert.equal(move().props.disabled, true, "nothing ticked is nothing to move");

  await act(async () => {
    harness.root
      .findAll((node) => node.type === "input" && node.props.type === "checkbox")[1]
      .props.onChange();
  });
  await act(async () => {
    move().props.onClick();
  });

  assert.equal(harness.accepted().length, 1);
  assert.deepEqual(harness.accepted()[0].groups?.lint, { commands: ["pnpm lint"] });
  // The unticked group is left exactly as the repository has it.
  assert.deepEqual(harness.accepted()[0].groups?.checks, { commands: ["pnpm test"] });
  assert.match(
    text(harness.root),
    /Accepted groups land in the Scripts tab as an unsaved draft\. You still save them with a reason\./,
  );
});

test("a dropped group is shown with its reason and its commands, and cannot be accepted", async (t) => {
  const harness = render(t, [
    () =>
      Response.json(
        proposal({
          droppedGroups: [
            {
              name: "deploy",
              commands: ["ssh prod 'systemctl restart app'"],
              reason: "remote_execution",
            },
          ],
        } as Partial<RepositoryCatalogSuggestResponse>),
      ),
  ]);
  await ask(harness);
  const rendered = text(harness.root);

  assert.match(rendered, /Refused, and not offered/);
  assert.match(rendered, /deploy/);
  assert.match(rendered, /systemctl restart app/);
  // Two ticks, for the two groups that were NOT dropped.
  assert.equal(
    harness.root.findAll(
      (node) => node.type === "input" && node.props.type === "checkbox",
    ).length,
    2,
  );
});

test("a timeout is NOT retried by the screen, and says the call is still billed", async (t) => {
  // The worker already waited 90 seconds and the call is billed whether or not
  // the model answered, so repeating it by itself spends a second unpriced call
  // on a model that is merely slow. The operator gets the button instead.
  const harness = render(t, [
    () => Response.json({ error: "suggestion_timed_out" }, { status: 503 }),
  ]);
  await ask(harness);

  assert.equal(harness.calls(), 1, "a timeout costs money; the screen does not repeat it");
  const rendered = text(harness.root);
  assert.match(rendered, /The model did not answer within 90 seconds/);
  assert.match(rendered, /counts against the cost page as unpriced/);
  assert.ok(button(harness.root, "Try again"));
});

test("a provider that is not answering is retried once, and the wait says so", async (t) => {
  const harness = render(t, [
    () => Response.json({ error: "suggestion_provider_unavailable" }, { status: 503 }),
    () => Response.json(proposal()),
  ]);
  await ask(harness);

  assert.equal(harness.calls(), 2, "one click, one automatic retry");
  assert.match(text(harness.root), /A storefront built on Next\.js\./);
});

test("the second attempt is not retried again, however the provider answers", async (t) => {
  const harness = render(t, [
    () => Response.json({ error: "suggestion_provider_unavailable" }, { status: 503 }),
    () => Response.json({ error: "suggestion_provider_unavailable" }, { status: 503 }),
  ]);
  await ask(harness);

  assert.equal(harness.calls(), 2, "one automatic retry per attempt, and no more");
  assert.match(text(harness.root), /The model provider is not answering/);
});

test("a malformed answer offers nothing and never shows the provider's own words", async (t) => {
  const harness = render(t, [
    () =>
      Response.json(
        { error: "suggestion_malformed", detail: "Unexpected token < in JSON at position 0" },
        { status: 502 },
      ),
  ]);
  await ask(harness);
  const rendered = text(harness.root);

  assert.match(rendered, /did not match the shape this screen can read/);
  assert.doesNotMatch(rendered, /Unexpected token/);
  // Nothing proposed means nothing tickable.
  assert.equal(
    harness.root.findAll(
      (node) => node.type === "input" && node.props.type === "checkbox",
    ).length,
    0,
  );
  assert.equal(harness.calls(), 1, "a 502 is not retried by the screen");
});

test("a failed profile read shows its redacted reason under the generic sentence", async (t) => {
  const harness = render(t, [
    () =>
      Response.json(
        {
          error: "profile_source_failed",
          failureReason: "profile source: GitHub answered 403 Forbidden",
        },
        { status: 502 },
      ),
  ]);
  await ask(harness);
  const rendered = text(harness.root);

  assert.match(rendered, /Reading the repository failed\. Nothing was changed\./);
  assert.match(rendered, /profile source: GitHub answered 403 Forbidden/);
});

test("a rate limit names the wait, counts it down, and refuses the click until it passes", async (t) => {
  const harness = render(t, [
    () =>
      Response.json(
        { error: "suggestion_rate_limited", retryAfterSeconds: 45 },
        { status: 429 },
      ),
  ]);
  await ask(harness);
  const rendered = text(harness.root);

  assert.match(rendered, /Try again in 45 seconds\./);
  assert.equal(
    harness.root.findAll(
      (node) => node.type === "button" && text(node).includes("Try again"),
    ).length,
    0,
  );
  // The ask button stays, disabled, counting down: a button that looks ready
  // and spends a round trip to be refused teaches the operator nothing.
  const asking = button(harness.root, "Rate limited");
  assert.equal(asking.props.disabled, true);
  assert.match(text(asking), /45s/);
});

test("both markdown fields show what is stored beside what the model proposed", async (t) => {
  // "Use this" overwrites outright, so the value it would destroy is on screen
  // before the click, exactly as it is for a script group.
  const harness = render(t, [() => Response.json(proposal())], {
    description: "Hand-written: the storefront, owned by the web guild.",
    rules: "Hand-written: never touch the generated client.",
  });
  await ask(harness);
  const rendered = text(harness.root);

  assert.match(rendered, /Hand-written: the storefront, owned by the web guild\./);
  assert.match(rendered, /A storefront built on Next\.js\./);
  assert.match(rendered, /Hand-written: never touch the generated client\./);
  assert.match(rendered, /Never touch the generated client\./);
});

test("a field with nothing stored says so rather than rendering an empty box", async (t) => {
  const harness = render(t, [() => Response.json(proposal())], {
    description: "",
    rules: "",
  });
  await ask(harness);
  assert.match(text(harness.root), /\(nothing recorded\)/);
});

test("a repository with no scripts entry is accepted into one carrying its own provider", async (t) => {
  // A default provider here would write a GitLab repository into the audited
  // profile blob as a GitHub one.
  const harness = render(t, [() => Response.json(proposal())], {
    current: null,
    repository: { provider: "gitlab", path: "acme/infra" },
  });
  await ask(harness);

  await act(async () => {
    harness.root
      .findAll((node) => node.type === "input" && node.props.type === "checkbox")[0]
      .props.onChange();
  });
  await act(async () => {
    button(harness.root, "into the Scripts draft").props.onClick();
  });

  assert.equal(harness.accepted().length, 1);
  assert.equal(harness.accepted()[0].provider, "gitlab");
  assert.equal(harness.accepted()[0].repoPath, "acme/infra");
});
