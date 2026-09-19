/**
 * A worker on localhost that answers from the agent visibility fixtures, so
 * the briefing and repository screens can be opened in a browser before the
 * real routes exist (stage 4 of docs/plans/2026-09-19-agent-visibility.md).
 *
 *   pnpm --filter ai-workflow-dashboard run fixture-worker
 *   WORKER_BASE_URL=http://127.0.0.1:4010 pnpm --filter ai-workflow-dashboard run dev
 *
 * Then open /ticket/AWP-235 with any `ba_session` cookie: the fixture worker
 * answers `/api/v1/session` for anything.
 *
 * `FIXTURE_FAIL=<pattern>` makes every path matching that regular expression
 * answer 503, which is how the "could not be loaded" states are looked at.
 */
import { createServer } from "node:http";

import { buildFixtureStore, serveFixture } from "../lib/agent-visibility/test-support/fixtures";

const port = Number(process.env.PORT ?? 4010);
const failing = process.env.FIXTURE_FAIL ? new RegExp(process.env.FIXTURE_FAIL) : null;

async function main() {
  const store = await buildFixtureStore();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
      console.log(`${status} ${request.method} ${url.pathname}${url.search}`);
    };
    if (failing?.test(url.pathname)) {
      send(503, { error: "The fixture worker is failing this path on purpose." });
      return;
    }
    const served = serveFixture(store, request.method ?? "GET", url);
    if (!served) {
      send(404, { error: "The fixture worker does not serve this path." });
      return;
    }
    send(served.status, served.body);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Fixture worker on http://127.0.0.1:${port} (ticket AWP-235, runs wrun_fx_planning and wrun_fx_states)`);
  });
}

void main();
