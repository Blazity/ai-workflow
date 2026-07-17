import { test } from "node:test";
import assert from "node:assert/strict";
import { pushRecentPromptId, readRecentPromptIds, type RecentStore } from "./recent.ts";

// Minimal in-memory Storage stand-in so the read/write round-trip runs under
// node:test with no DOM.
function fakeStore(initial?: string): RecentStore {
  let value: string | null = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key, v) => {
      value = v;
    },
  };
}

test("readRecentPromptIds returns [] when nothing is stored", () => {
  assert.deepEqual(readRecentPromptIds(fakeStore()), []);
});

test("pushRecentPromptId seeds the list", () => {
  const store = fakeStore();
  pushRecentPromptId(1, store);
  assert.deepEqual(readRecentPromptIds(store), [1]);
});

test("dedupe moves an existing id to the front", () => {
  const store = fakeStore(JSON.stringify([3, 2, 1]));
  pushRecentPromptId(2, store);
  assert.deepEqual(readRecentPromptIds(store), [2, 3, 1]);
});

test("most recent push is first", () => {
  const store = fakeStore();
  pushRecentPromptId(1, store);
  pushRecentPromptId(2, store);
  pushRecentPromptId(3, store);
  assert.deepEqual(readRecentPromptIds(store), [3, 2, 1]);
});

test("list is capped at 8, dropping the oldest", () => {
  const store = fakeStore();
  for (let i = 1; i <= 10; i++) pushRecentPromptId(i, store);
  assert.deepEqual(readRecentPromptIds(store), [10, 9, 8, 7, 6, 5, 4, 3]);
});

test("garbage JSON is tolerated as an empty list", () => {
  assert.deepEqual(readRecentPromptIds(fakeStore("not json")), []);
});

test("a non-array payload is tolerated", () => {
  assert.deepEqual(readRecentPromptIds(fakeStore(JSON.stringify({ a: 1 }))), []);
});

test("non-integer and non-numeric entries are filtered out", () => {
  assert.deepEqual(readRecentPromptIds(fakeStore(JSON.stringify([1, "x", null, 2.5, 3]))), [1, 3]);
});
