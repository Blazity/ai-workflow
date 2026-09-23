/**
 * The worker half against a provider that is a function: every request goes
 * through the `ctx.http.fetch` this test hands in, so nothing touches the
 * network and each case says exactly what the provider answered.
 *
 * Keep tests beside the code they cover, in any folder of the package: the
 * `test` script runs every `*.test.ts` and `*.test.tsx` below the package root.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runtime } from "./worker";

type Lookup = typeof runtime.blocks.example_lookup;
type LookupContext = Parameters<Lookup>[1];

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** A context whose provider answers every request with `answer`, and the URLs it was asked for. */
function providerAnswering(answer: () => Response) {
  const asked: URL[] = [];
  const ctx = {
    connection: { baseUrl: "https://api.example.test", apiToken: "not-a-real-token" },
    http: {
      fetch: async (input: string | URL | Request) => {
        asked.push(new URL(input instanceof Request ? input.url : input));
        return answer();
      },
    },
    log: quiet,
    signal: new AbortController().signal,
    run: { runId: "run-1", nodeId: "lookup", attempt: 1, subjectKey: "ticket:example:EX-1", state: null },
    capabilities: {},
  } as unknown as LookupContext;
  return { ctx, asked };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a search that matched lists what it found", async () => {
  const { ctx, asked } = providerAnswering(() =>
    json(200, { total: 2, items: [{ title: "Login fails" }, { title: "Login slow" }] }),
  );
  const outcome = await runtime.blocks.example_lookup({ params: { limit: 5 }, inputs: { query: "login" } }, ctx);
  assert.deepEqual(outcome, {
    kind: "next",
    output: { status: "found", summary: "Login fails\nLogin slow", matches: 2 },
  });
  assert.equal(asked[0]?.searchParams.get("q"), "login");
  assert.equal(asked[0]?.searchParams.get("limit"), "5");
});

test("a search that matched nothing says so rather than failing", async () => {
  const { ctx } = providerAnswering(() => json(200, { total: 0, items: [] }));
  const outcome = await runtime.blocks.example_lookup({ params: { limit: 5 }, inputs: { query: "x" } }, ctx);
  assert.equal(outcome.kind === "next" && outcome.output.status, "nothing_found");
});

test("a provider error is the block's failure, with the status a person can act on", async () => {
  const { ctx } = providerAnswering(() => json(500, { error: "boom" }));
  const outcome = await runtime.blocks.example_lookup({ params: { limit: 5 }, inputs: { query: "x" } }, ctx);
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.kind === "failed" ? outcome.message : "", /500/u);
});

test("the connection test refuses a rejected token and throws when the provider cannot answer", async () => {
  const refused = providerAnswering(() => json(401, {}));
  assert.deepEqual(await runtime.testConnection(refused.ctx), {
    ok: false,
    reason: "Example refused the API token (401).",
  });
  const down = providerAnswering(() => json(503, {}));
  await assert.rejects(runtime.testConnection(down.ctx), /503/u);
});
