import { expect, test } from "vitest";

/**
 * Deliberate failure. This file exists only to prove that one red worker shard
 * turns the required `ci` aggregator red and that its log names `unit-worker`.
 * Stage 0 probe of docs/plans/2026-09-09-architecture-restructure.md. It lives
 * on a throwaway branch that is closed unmerged, and never on main.
 */
test("ci aggregator probe: this assertion fails on purpose", () => {
  expect(false).toBe(true);
});
