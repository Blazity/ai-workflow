import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFINITION_GOLDEN_PATH,
  definitionGoldenCorpus,
  renderDefinitionGolden,
} from "../../../test-support/definition-golden-corpus.js";

/**
 * The contract of the schema split: the same definitions produce the same
 * issues, in the same order, with the same messages, before and after the
 * structural rules moved into `@shared/workflow-graph`.
 *
 * `definition-deployment-issues.json` was recorded on the stage base
 * (7d702ec3185a2a06ced9d6f85be6b3de66aa487b) with every rule still inside
 * `workflow-definition/schema.ts`, and this comparison is a byte comparison on
 * purpose. A structural diff would let issue order drift, and order is exactly
 * what a composition assembled from two modules can lose without any single
 * rule changing.
 *
 * Nothing here regenerates the fixture. Re-recording is a decision a person
 * makes with `pnpm --filter worker run capture:definition-golden -- --write`,
 * and the diff it produces is the review.
 */
describe("definition deployment issue golden", () => {
  it("matches the fixture recorded on the stage base", () => {
    expect(renderDefinitionGolden()).toBe(
      readFileSync(DEFINITION_GOLDEN_PATH, "utf8"),
    );
  });

  it("is recomputed, not read: every corpus fixture appears once", () => {
    const names = definitionGoldenCorpus().map((entry) => entry.fixture);
    const recorded = (
      JSON.parse(readFileSync(DEFINITION_GOLDEN_PATH, "utf8")) as {
        fixture: string;
      }[]
    ).map((record) => record.fixture);
    expect(new Set(names).size).toBe(names.length);
    expect(recorded).toEqual(names);
  });
});
