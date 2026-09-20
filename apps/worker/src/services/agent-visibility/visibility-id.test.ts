/**
 * The reader's copy of capture's id transform, against vectors computed
 * independently of both copies.
 *
 * The expected strings below were produced by a separate FNV-1a implementation
 * written from the algorithm's definition, not by running either copy: a test
 * that asked this function what it does would agree with any drift.
 */
import { describe, expect, it } from "vitest";

import { shortenVisibilityId } from "./visibility-id.js";

describe("shortenVisibilityId", () => {
  // Red when: the bound is applied to ids that fit, which would rewrite every
  // ordinary node id and match nothing in either table.
  it("leaves an id that fits exactly as it is", () => {
    expect(shortenVisibilityId("planning")).toBe("planning");
    expect(shortenVisibilityId("n".repeat(200))).toBe("n".repeat(200));
    expect(shortenVisibilityId("root/loop:planning:7")).toBe("root/loop:planning:7");
  });

  // Red when: the head, the separator or either hash pass drifts from the copy
  // in apps/worker/src/engine/agent-visibility/plan.ts, which is the spelling
  // every stored briefing of a long-named node already carries.
  it("shortens past the bound to capture's exact spelling", () => {
    expect(shortenVisibilityId("n".repeat(201))).toBe(`${"n".repeat(150)}~a8569a518298a027`);
    expect(shortenVisibilityId(`root/loop:${"deeply-named-node-".repeat(20)}:7`)).toBe(
      "root/loop:deeply-named-node-deeply-named-node-deeply-named-node-deeply-named-node-deeply-named-node-deeply-named-node-deeply-named-node-deeply-named-n~518b0845d547764f",
    );
  });

  // Red when: the cut lands between the two halves of one character, which
  // stores an id no equality will ever match and no screen can print.
  it("never cuts a character in half", () => {
    const astral = `${"x".repeat(149)}\u{1F680}${"y".repeat(200)}`;

    const short = shortenVisibilityId(astral);

    expect(short).toBe(`${"x".repeat(149)}~c11c8fcd7b5d820b`);
    expect(short).not.toContain("\uD83D");
    expect([...short].length).toBe(short.length);
  });

  // Red when: the transform is not idempotent, so an id a caller read off a
  // list and handed back is shortened a second time and matches nothing.
  it("leaves its own output alone", () => {
    const once = shortenVisibilityId("n".repeat(400));

    expect(shortenVisibilityId(once)).toBe(once);
    expect(once.length).toBeLessThanOrEqual(167);
  });
});
