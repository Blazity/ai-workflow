// apps/dashboard/lib/agent-visibility/effects.test.ts
//
// The decision trail is written by the worker and read here. The mistake this
// guards is a round that goes blank, or quietly loses a line, the day the
// worker records an event kind or a field this build has never seen.
import assert from "node:assert/strict";
import test from "node:test";

import type { ClarificationEffect } from "@shared/agent-visibility";

import { describeEffect } from "./effects";
import { buildFixtureStore, LEGACY, SHOP_WEB, type FixtureStore } from "./test-support/fixtures";

let store: FixtureStore;
test.before(async () => {
  store = await buildFixtureStore();
});

function effects(roundId: string): ClarificationEffect[] {
  const round = store.rounds.find((entry) => entry.id === roundId);
  assert.ok(round, `no round ${roundId}`);
  return [...round.effects];
}

// The question was asked twice (clr_1, then clr_1b); the package assembles
// both asks into one round, under the first clarification's id.
test("taking an answer says who answered and what was taken from it", () => {
  const taken = effects("clr_1").find((effect) => effect.event.kind === "question_answered");
  assert.ok(taken);
  const described = describeEffect(taken);
  assert.equal(described.title, "The answer was taken");
  assert.match(described.detail ?? "", new RegExp(`The person named ${SHOP_WEB}`));
  assert.match(described.detail ?? "", /answered by Filip Maszota/);
});

test("writing an entry says the repository, the state, who and why", () => {
  const written = effects("clr_2").find((effect) => effect.event.kind === "entry_written");
  assert.ok(written);
  const described = describeEffect(written);
  assert.equal(described.title, "The record was written");
  assert.match(described.detail ?? "", new RegExp(`${LEGACY} is excluded`));
  assert.match(described.detail ?? "", /by Filip Maszota/);
  assert.match(described.detail ?? "", /not part of this work/);
  assert.match(described.detail ?? "", /It was excluded before\./);
});

test("an event kind from a newer worker is shown as itself, with everything it carried", () => {
  // `map_linked` is in the fixture trail because a newer worker writes it.
  const linked = effects("clr_4").find((effect) => effect.event.kind === "map_linked");
  assert.ok(linked, "the fixture round lost its unknown event");
  const described = describeEffect(linked);
  assert.equal(described.title, 'The worker recorded "map_linked"');
  assert.match(described.extra ?? "", /"mapVersion":3/);
  assert.match(described.extra ?? "", /from a newer worker/);
});

test("a known event that carries a new field keeps its sentence and shows the field", () => {
  const written = effects("clr_2").find((effect) => effect.event.kind === "entry_written")!;
  const widened: ClarificationEffect = {
    ...written,
    event: { ...written.event, decidedUnder: "policy v9" } as never,
  };
  const described = describeEffect(widened);
  assert.equal(described.title, "The record was written");
  assert.match(described.detail ?? "", new RegExp(`${LEGACY} is excluded`));
  assert.equal(described.extra, '{"decidedUnder":"policy v9"}');
});

test("an entry the dashboard cannot read still leaves a readable line", () => {
  const written = effects("clr_2").find((effect) => effect.event.kind === "entry_written")!;
  const broken: ClarificationEffect = { ...written, event: { kind: "entry_written", entry: null } as never };
  const described = describeEffect(broken);
  assert.equal(described.title, "The record was written");
  assert.match(described.detail ?? "", /an entry this dashboard cannot read/);
});
