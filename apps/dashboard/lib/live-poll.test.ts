// apps/dashboard/lib/live-poll.test.ts
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createLivePoll } from "./live-poll.ts";

// Minimal fake visibility source so the controller runs without a DOM.
function makeVisibility(initialHidden = false) {
  let hidden = initialHidden;
  const subs = new Set<() => void>();
  return {
    isHidden: () => hidden,
    subscribe: (cb: () => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    set(next: boolean) {
      hidden = next;
      for (const cb of subs) cb();
    },
    subscriberCount: () => subs.size,
  };
}

function setup(initialHidden = false) {
  const vis = makeVisibility(initialHidden);
  let ticks = 0;
  const poll = createLivePoll({
    intervalMs: 5000,
    onTick: () => {
      ticks++;
    },
    isHidden: vis.isHidden,
    subscribeVisibility: vis.subscribe,
  });
  return { vis, poll, ticks: () => ticks };
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setInterval"] });
});
afterEach(() => {
  mock.timers.reset();
});

test("ticks every interval while started and visible", () => {
  const { poll, ticks } = setup(false);
  poll.start();
  mock.timers.tick(5000);
  mock.timers.tick(5000);
  assert.equal(ticks(), 2);
});

test("stop() clears the interval", () => {
  const { poll, ticks } = setup(false);
  poll.start();
  mock.timers.tick(5000);
  poll.stop();
  mock.timers.tick(5000);
  mock.timers.tick(5000);
  assert.equal(ticks(), 1);
});

test("started while hidden does not tick until visible", () => {
  const { poll, ticks } = setup(true);
  poll.start();
  mock.timers.tick(5000);
  assert.equal(ticks(), 0);
});

test("becoming visible fires once immediately then resumes interval", () => {
  const { vis, poll, ticks } = setup(true);
  poll.start();
  vis.set(false); // immediate tick on becoming visible
  assert.equal(ticks(), 1);
  mock.timers.tick(5000); // interval resumes
  assert.equal(ticks(), 2);
});

test("becoming hidden mid-run pauses ticks", () => {
  const { vis, poll, ticks } = setup(false);
  poll.start();
  mock.timers.tick(5000); // 1
  vis.set(true); // pause
  mock.timers.tick(5000);
  mock.timers.tick(5000);
  assert.equal(ticks(), 1);
});

test("after stop(), a later visibility change does not tick (unsubscribed)", () => {
  const { vis, poll, ticks } = setup(false);
  poll.start();
  poll.stop();
  assert.equal(vis.subscriberCount(), 0);
  vis.set(true);
  vis.set(false);
  mock.timers.tick(5000);
  assert.equal(ticks(), 0);
});

// The three cases below replace #253's `maxTicks` / `isActive` cases. Those two
// mechanisms are gone: a tick counter cannot know how long a run takes, and once
// its budget was spent `startInterval` refused to run again, so the visibility
// handler could only buy a single refresh per return. What a caller wants
// instead is expressed by disabling the poll (see AIW-266).

test("a long-lived run keeps ticking well past any five minute budget", () => {
  const { poll, ticks } = setup(false);
  poll.start();
  mock.timers.tick(12 * 60_000);
  assert.equal(ticks(), 144);
});

test("returning to the tab after a long session resumes the cycle, not one tick", () => {
  const { vis, poll, ticks } = setup(false);
  poll.start();
  mock.timers.tick(6 * 60_000);
  const beforeHide = ticks();
  vis.set(true);
  mock.timers.tick(60_000);
  assert.equal(ticks(), beforeHide, "a hidden tab must not tick");
  vis.set(false);
  assert.equal(ticks(), beforeHide + 1, "coming back refreshes immediately");
  mock.timers.tick(30_000);
  assert.equal(ticks(), beforeHide + 7, "and the interval is running again");
});

test("reports when the interval starts and stops so the UI can say so", () => {
  const vis = makeVisibility(false);
  const states: boolean[] = [];
  const poll = createLivePoll({
    intervalMs: 5000,
    onTick: () => {},
    onRunningChange: (running) => states.push(running),
    isHidden: vis.isHidden,
    subscribeVisibility: vis.subscribe,
  });
  poll.start();
  vis.set(true);
  vis.set(false);
  poll.stop();
  assert.deepEqual(states, [true, false, true, false]);
});
