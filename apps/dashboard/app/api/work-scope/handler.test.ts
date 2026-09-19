// apps/dashboard/app/api/work-scope/handler.test.ts
//
// The repository record is asked for by subject key. The mistakes worth
// guarding: asking the worker for a record with no subject (which is not a
// question it should be asked), letting a caller shape the worker path, and
// dropping the subject key from a round's deliveries, where it is what scopes
// the read.
import assert from "node:assert/strict";
import test from "node:test";

import { handleWorkScopeEdit, handleWorkScopeGet } from "./handler";

const context = (path?: string[]) => ({ params: Promise.resolve({ path }) });
const SUBJECT = "ticket:jira:AWP-235";
const encoded = encodeURIComponent(SUBJECT);

async function forwarded(url: string, path?: string[]) {
  const calls: string[] = [];
  const response = await handleWorkScopeGet(new Request(url), context(path), async (workerPath) => {
    calls.push(workerPath);
    return Response.json({ subjectKey: SUBJECT, entries: [] });
  });
  return { calls, response };
}

test("a ticket's record is asked for by its subject key, with the rounds opt-in", async () => {
  const { calls, response } = await forwarded(
    `https://dashboard.test/api/work-scope?subjectKey=${encoded}&rounds=true&roundsCursor=r2`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [`/api/v1/work-scope?subjectKey=${encoded}&rounds=true&roundsCursor=r2`]);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("the rounds opt-in is a yes or a no, and nothing else reaches the worker", async () => {
  let called = false;
  const refused = await handleWorkScopeGet(
    new Request(`https://dashboard.test/api/work-scope?subjectKey=${encoded}&rounds=please`),
    context(),
    async () => {
      called = true;
      return Response.json({});
    },
  );
  assert.equal(refused.status, 400);
  assert.equal(called, false);

  const off = await forwarded(`https://dashboard.test/api/work-scope?subjectKey=${encoded}&rounds=false`);
  assert.deepEqual(off.calls, [`/api/v1/work-scope?subjectKey=${encoded}&rounds=false`]);
});

test("a round's deliveries and effects keep the subject key that scopes them", async () => {
  const deliveries = await forwarded(
    `https://dashboard.test/api/work-scope/rounds/clr_2/deliveries?subjectKey=${encoded}&cursor=d2&limit=524288`,
    ["rounds", "clr_2", "deliveries"],
  );
  assert.deepEqual(deliveries.calls, [
    `/api/v1/work-scope/rounds/clr_2/deliveries?subjectKey=${encoded}&cursor=d2&limit=524288`,
  ]);

  const effects = await forwarded(
    `https://dashboard.test/api/work-scope/rounds/clr_2/effects?subjectKey=${encoded}`,
    ["rounds", "clr_2", "effects"],
  );
  assert.deepEqual(effects.calls, [`/api/v1/work-scope/rounds/clr_2/effects?subjectKey=${encoded}`]);
});

test("without a subject key the worker is never asked", async () => {
  let called = false;
  const response = await handleWorkScopeGet(
    new Request("https://dashboard.test/api/work-scope"),
    context(),
    async () => {
      called = true;
      return Response.json({});
    },
  );
  assert.equal(response.status, 400);
  assert.equal(called, false);
  assert.deepEqual(await response.json(), { error: "subjectKey is required" });
});

test("a subject key with control characters is refused", async () => {
  let called = false;
  const response = await handleWorkScopeGet(
    new Request("https://dashboard.test/api/work-scope?subjectKey=ticket%3Ajira%3AA%00B"),
    context(),
    async () => {
      called = true;
      return Response.json({});
    },
  );
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test("a path this route does not serve never reaches the worker", async () => {
  for (const path of [
    ["rounds"],
    ["rounds", "clr_1"],
    ["rounds", "clr_1", "words"],
    ["rounds", "../../settings", "effects"],
    ["entries"],
  ]) {
    let called = false;
    const response = await handleWorkScopeGet(
      new Request(`https://dashboard.test/api/work-scope?subjectKey=${encoded}`),
      context(path),
      async () => {
        called = true;
        return Response.json({});
      },
    );
    assert.equal(response.status, 404, `${path.join("/")} was not refused`);
    assert.equal(called, false, `${path.join("/")} reached the worker`);
  }
});

test("a worker that does not answer in time is a 504, not a crash", async () => {
  const response = await handleWorkScopeGet(
    new Request(`https://dashboard.test/api/work-scope?subjectKey=${encoded}`),
    context(),
    async () => {
      throw new DOMException("Timed out", "TimeoutError");
    },
  );
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "Worker request timed out" });
});

/* ── Editing ───────────────────────────────────────────────────────────── */

async function edited(url: string, body: unknown, path?: string[]) {
  const calls: { path: string; method?: string; body?: string; contentType?: string }[] = [];
  const response = await handleWorkScopeEdit(
    new Request(url, { method: "PATCH", body: JSON.stringify(body) }),
    context(path),
    async (workerPath, init) => {
      calls.push({
        path: workerPath,
        ...(init?.method === undefined ? {} : { method: init.method }),
        ...(init?.body === undefined ? {} : { body: String(init.body) }),
        ...(new Headers(init?.headers).get("content-type") === null
          ? {}
          : { contentType: new Headers(init?.headers).get("content-type")! }),
      });
      return Response.json({ scope: { subjectKey: SUBJECT, version: 5, entries: [] } });
    },
  );
  return { calls, response };
}

test("a change reaches the worker whole, as a PATCH of the record itself", async () => {
  const change = {
    subjectKey: SUBJECT,
    expectedVersion: 4,
    changes: [{ repositoryKey: "github:acme/shop-web", action: "exclude", rationale: "I meant the API only." }],
  };
  const { calls, response } = await edited("https://dashboard.test/api/work-scope", change);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    {
      path: "/api/v1/work-scope",
      method: "PATCH",
      // Byte for byte: what a change may say is the worker's to decide, and a
      // second copy of those rules here is a second place to get them wrong.
      body: JSON.stringify(change),
      contentType: "application/json",
    },
  ]);
});

test("the worker's refusal reaches the person who asked, status and body untouched", async () => {
  const response = await handleWorkScopeEdit(
    new Request("https://dashboard.test/api/work-scope", { method: "PATCH", body: "{}" }),
    context(),
    async () => Response.json({ error: "version_conflict", latestVersion: 9 }, { status: 409 }),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "version_conflict", latestVersion: 9 });
});

test("the record is edited at the record's own route, never under a round", async () => {
  let called = false;
  const response = await handleWorkScopeEdit(
    new Request("https://dashboard.test/api/work-scope/rounds/clr_2/effects", { method: "PATCH", body: "{}" }),
    context(["rounds", "clr_2", "effects"]),
    async () => {
      called = true;
      return Response.json({});
    },
  );
  assert.equal(response.status, 404);
  assert.equal(called, false);
});
