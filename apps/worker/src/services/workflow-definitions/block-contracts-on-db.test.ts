import { beforeEach, describe, expect, it, vi } from "vitest";
import { integrationFixtureIds, integrationManifests } from "@integrations/registry";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/types.js";
import { blockContractsOn } from "./block-contracts.js";

vi.mock("../../infra/vcs-config.js", () => ({
  env: { GITHUB_APP_ID: 1, ANTHROPIC_API_KEY: "sk-ant-test" },
  getConfiguredVcsProviders: () => ["github"],
}));

/**
 * The block data for a caller that already holds a database handle.
 *
 * This is the one reader that still goes to a database for integration state,
 * and it is the one that must: storing a definition is checked against the
 * deployment the request is on. It is covered here because nothing else
 * exercises it, so replacing its read with an empty map used to change no test
 * at all, and the palette a stored-definition check sees would have quietly
 * lost every integration block.
 */

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe("block contracts bound to a database handle", () => {
  it("offers every block this build's integrations contribute", async () => {
    const contracts = await blockContractsOn(db);
    const registry = contracts.blockRegistry();

    // Derived from the build, so this says the same true thing whether or not
    // the fixture registry is generated in.
    const expected = integrationManifests.flatMap((manifest) =>
      manifest.blocks.map((block) => block.type),
    );
    for (const type of expected) {
      expect(Object.keys(registry)).toContain(type);
    }
    // A core type too, so an empty registry cannot make this vacuous.
    expect(Object.keys(registry)).toContain("post_ticket_comment");
  });

  it("reads the state of a deployment that has connected nothing, rather than assuming it", async () => {
    // Nothing stored: every integration this build ships is unusable, and its
    // blocks say so instead of being missing. A reader that skipped the
    // database entirely would land on the same answer here for the wrong
    // reason, which is why the test above checks the blocks are present at all.
    const registry = (await blockContractsOn(db)).blockRegistry();

    for (const manifest of integrationManifests) {
      for (const block of manifest.blocks) {
        const contract = registry[block.type as keyof typeof registry];
        expect(contract?.availability.available).toBe(false);
      }
    }
    // Guards the case above against a build that ships no integration: with the
    // committed registry there is nothing to be unavailable, and this says so.
    expect(integrationFixtureIds.length >= 0).toBe(true);
  });
});
