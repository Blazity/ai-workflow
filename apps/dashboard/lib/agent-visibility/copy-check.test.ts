// apps/dashboard/lib/agent-visibility/copy-check.test.ts
//
// Copy hands a person the exact prompt text to paste into a ticket or a bug
// report. The mistakes worth catching are the silent ones: a section copied a
// page short, a page copied twice, or text something rewrote on the way. Each
// must stop the copy, not produce a plausible-looking paste.
import assert from "node:assert/strict";
import test from "node:test";

import { checkStoredText } from "./copy-check";
import { buildFixtureStore, PLANNING_RUN, serveFixture, type FixtureStore } from "./test-support/fixtures";

let store: FixtureStore;
test.before(async () => {
  store = await buildFixtureStore();
});

/** Every page of a section's text, as the reader loads them. */
function pages(briefingId: string, sectionIndex: number): { text: string }[] {
  const loaded: { text: string }[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const served = serveFixture(
      store,
      "GET",
      new URL(
        `/api/v1/runs/${PLANNING_RUN}/briefings/${briefingId}/sections/${sectionIndex}?offset=${offset}`,
        "http://worker.test",
      ),
    );
    assert.ok(served && served.status === 200);
    const page = served.body as { text: string; nextOffset: number | null };
    loaded.push({ text: page.text });
    offset = page.nextOffset;
  }
  return loaded;
}

function stored(briefingId: string, sectionIndex: number) {
  const section = store.briefings.get(briefingId)!.sections[sectionIndex]!;
  return { storedBytes: section.storedBytes, storedSha256: section.storedSha256 };
}

test("every page loaded, in order, is the text the worker stored", async () => {
  const loaded = pages("brf_plan_2", 4);
  assert.ok(loaded.length > 1, "this section should need more than one page");
  const check = await checkStoredText(loaded, stored("brf_plan_2", 4));
  assert.ok(check.ok, check.ok ? "" : check.message);
  assert.equal(check.digestChecked, true);
  assert.equal(new TextEncoder().encode(check.text).length, stored("brf_plan_2", 4).storedBytes);
});

test("a section one page short is refused, with both sizes", async () => {
  const loaded = pages("brf_plan_2", 4);
  const check = await checkStoredText(loaded.slice(0, -1), stored("brf_plan_2", 4));
  assert.equal(check.ok, false);
  assert.match(check.ok === false ? check.message : "", /so nothing was copied/);
  assert.match(check.ok === false ? check.message : "", new RegExp(`${stored("brf_plan_2", 4).storedBytes}`));
});

test("a page loaded twice is refused", async () => {
  const loaded = pages("brf_plan_2", 4);
  const check = await checkStoredText([...loaded, loaded[0]!], stored("brf_plan_2", 4));
  assert.equal(check.ok, false);
});

test("text rewritten on the way is refused even when the length holds", async () => {
  const loaded = pages("brf_plan_2", 4);
  const first = loaded[0]!.text;
  const swapped = [{ text: `X${first.slice(1)}` }, ...loaded.slice(1)];
  const check = await checkStoredText(swapped, stored("brf_plan_2", 4));
  assert.equal(check.ok, false);
  assert.match(check.ok === false ? check.message : "", /does not match the digest/);
});

test("without Web Crypto the copy is still offered, and says the digest went unchecked", async () => {
  const loaded = pages("brf_plan_2", 4);
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    const check = await checkStoredText(loaded, stored("brf_plan_2", 4));
    assert.ok(check.ok, check.ok ? "" : check.message);
    assert.equal(check.digestChecked, false);
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
  }
});
