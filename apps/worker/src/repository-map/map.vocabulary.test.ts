/**
 * The map spells the repository state and inclusion vocabularies itself, rather
 * than importing them, because it is reachable from the workflow isolate and
 * `@shared/agent-visibility` carries a runtime zod dependency the isolate's
 * bundle may not pull in.
 *
 * A COPY IS ONLY SAFE WHILE SOMETHING HOLDS IT EQUAL. The briefing records a
 * repository's state and cause as the map produced them, and its write schema
 * refuses a state it does not know; a value added on one side and forgotten on
 * the other would be a briefing that will not store, found in production
 * instead of here.
 */
import { describe, expect, it } from "vitest";
// By path rather than by package name on purpose: the worker does not depend
// on `@shared/agent-visibility` yet (the capture half that will is a separate
// delivery), and adding the dependency to make one test resolve would put a
// package in the worker's bundle graph before anything in it uses one.
import {
  REPOSITORY_INCLUSION_CAUSES,
  REPOSITORY_STATES,
  USABLE_REPOSITORY_STATES,
} from "../../../../packages/agent-visibility/vocabulary";
import {
  REPOSITORY_MAP_CAUSES,
  REPOSITORY_MAP_STATES,
  USABLE_REPOSITORY_MAP_STATES,
} from "./map.js";

describe("the map's vocabulary", () => {
  it("is the briefing's repository states, in the same order", () => {
    expect([...REPOSITORY_MAP_STATES]).toEqual([...REPOSITORY_STATES]);
  });

  it("is the briefing's usable states", () => {
    expect([...USABLE_REPOSITORY_MAP_STATES]).toEqual([...USABLE_REPOSITORY_STATES]);
  });

  it("is the briefing's inclusion causes", () => {
    expect([...REPOSITORY_MAP_CAUSES]).toEqual([...REPOSITORY_INCLUSION_CAUSES]);
  });
});
