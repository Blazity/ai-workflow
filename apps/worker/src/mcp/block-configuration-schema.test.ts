import { describe, expect, it } from "vitest";

import { blockParamsSchemasFor } from "../engine/definition/block-params-schemas.js";
import { NO_INTEGRATIONS } from "../engine/definition/integration-availability.js";
import { blockConfigurationSchema } from "./block-configuration-schema.js";

// Also in `vitest.zod4.config.ts`: production converts through zod 4's own
// `toJSONSchema` and these tests otherwise run zod 3's path, so the half the
// deployment actually runs is proven there and not only assumed.
describe("blockConfigurationSchema", () => {
  const schemas = blockParamsSchemasFor(NO_INTEGRATIONS) as Record<string, unknown>;

  it("describes every core block's configuration as an object schema", async () => {
    for (const [type, schema] of Object.entries(schemas)) {
      const described = await blockConfigurationSchema(schema);
      expect(described.type, type).toBe("object");
      expect(described, type).not.toHaveProperty("$schema");
    }
  });

  // Red when: a converter fails on a check JSON Schema cannot express (a
  // `z.custom` reference, which zod 4 refuses by default) and the block is
  // answered with nothing to go on.
  it("describes the loop, whose carry holds checks JSON Schema cannot state, by its keys", async () => {
    const described = await blockConfigurationSchema(schemas.loop);

    expect(described.properties).toMatchObject({
      maxAttempts: expect.any(Object),
      onExhaust: expect.any(Object),
      carry: expect.any(Object),
    });
    expect(described.description).toBeUndefined();
  });

  it("names a pinned Harness Profile among an agent block's keys", async () => {
    const described = await blockConfigurationSchema(schemas.planning_agent);

    expect(described.properties).toMatchObject({
      harnessProfile: {
        type: "object",
        properties: { profileId: { type: "string" }, version: { type: "integer" } },
      },
    });
  });
});
