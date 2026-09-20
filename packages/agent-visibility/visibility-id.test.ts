/**
 * The one id transform, against vectors computed independently of it.
 *
 * The expected strings below were produced by a separate FNV-1a implementation
 * written from the algorithm's definition, not by running this function: a
 * test that asked it what it does would agree with any drift. They moved here
 * unchanged from the reader's copy in
 * `apps/worker/src/services/agent-visibility/visibility-id.test.ts`, so they
 * still pin the exact spelling every briefing already stored carries.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { shortenVisibilityId } from "./index";

// Red when: the bound is applied to ids that fit, which would rewrite every
// ordinary node id and match nothing in either table.
test("leaves an id that fits exactly as it is", () => {
  assert.equal(shortenVisibilityId("planning"), "planning");
  assert.equal(shortenVisibilityId("n".repeat(200)), "n".repeat(200));
  assert.equal(shortenVisibilityId("root/loop:planning:7"), "root/loop:planning:7");
});

// Red when: the head, the separator or either hash pass drifts, which is the
// spelling every stored briefing of a long-named node already carries. Capture
// and the read model now share this function, so a drift here moves both at
// once and silently orphans what is already in the table.
test("shortens past the bound to the stored spelling", () => {
  assert.equal(shortenVisibilityId("n".repeat(201)), `${"n".repeat(150)}~a8569a518298a027`);
  assert.equal(
    shortenVisibilityId(`root/loop:${"deeply-named-node-".repeat(20)}:7`),
    "root/loop:deeply-named-node-deeply-named-node-deeply-named-node-deeply-named-node-deeply-named-node-deeply-named-node-deeply-named-node-deeply-named-n~518b0845d547764f",
  );
});

// Red when: the cut lands between the two halves of one character, which
// stores an id no equality will ever match and no screen can print.
test("never cuts a character in half", () => {
  const astral = `${"x".repeat(149)}\u{1F680}${"y".repeat(200)}`;

  const short = shortenVisibilityId(astral);

  assert.equal(short, `${"x".repeat(149)}~c11c8fcd7b5d820b`);
  assert.ok(!short.includes("\uD83D"));
  assert.equal([...short].length, short.length);
});

// Red when: the transform is not idempotent, so an id a caller read off a
// list and handed back is shortened a second time and matches nothing.
test("leaves its own output alone", () => {
  const once = shortenVisibilityId("n".repeat(400));

  assert.equal(shortenVisibilityId(once), once);
  assert.ok(once.length <= 167);
});

// Red when: the hash stops covering the whole id, so two loop iterations
// around one long-named node shorten to the same id and the second send
// overwrites the first under the same identity. Asserted on the shape the
// scheduler really builds; capture.test.ts holds the same property end to end.
test("tells two iterations of one long-named node apart", () => {
  const node = "n".repeat(200);

  const third = shortenVisibilityId(`root/loop:${node}:3`);
  const fourth = shortenVisibilityId(`root/loop:${node}:4`);

  assert.ok(third.length <= 200);
  assert.notEqual(third, fourth);
});
