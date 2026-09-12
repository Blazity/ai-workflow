import { describe, expect, it } from "vitest";
import { BLOCK_TYPE_SPECS, type WorkflowBlockType } from "@shared/contracts";
import { BLOCK_PARAMS_SCHEMAS } from "./block-params-schemas.js";

/**
 * The `satisfies` in the map is the compile-time half of this. This is the
 * run-time half: a type added to the catalog without an entry here would parse
 * against nothing, and a definition naming it would deploy unchecked.
 */
describe("block params schemas", () => {
  it("has a parser for every block type in the catalog", () => {
    const catalogTypes = Object.keys(BLOCK_TYPE_SPECS).sort() as WorkflowBlockType[];
    expect(catalogTypes.length).toBeGreaterThan(0);
    expect(Object.keys(BLOCK_PARAMS_SCHEMAS).sort()).toEqual(catalogTypes);
    for (const type of catalogTypes) {
      expect(typeof BLOCK_PARAMS_SCHEMAS[type].safeParse, type).toBe("function");
    }
  });
});
