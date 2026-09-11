import { describe, expect, it } from "vitest";
import type { HarnessCapabilityCatalog } from "@shared/contracts";
import { createTestDb } from "../test-db.js";
import { harnessCapabilityCatalogs, organization } from "../schema.js";
import { upsertHarnessCapabilityCatalog } from "./harness-capability-catalogs.js";

const catalog = (modelId: string): HarnessCapabilityCatalog => ({
  provider: "codex",
  packageName: "@openai/codex",
  cliVersion: "0.144.6",
  protocolVersion: "codex-jsonl-0.144.6",
  models: [{
    id: modelId,
    name: modelId,
    description: null,
    contextWindowTokens: 200_000,
    reasoningEfforts: [{ id: "high", name: "High", description: null }],
    defaultReasoningEffort: "high",
    serviceTiers: [{ id: "standard", name: "Standard", description: null }],
    defaultServiceTier: "standard",
    verbosityOptions: [],
    defaultVerbosity: null,
    compactionModes: ["model_default"],
  }],
});

describe("harness capability catalog repository", () => {
  it("updates the matching catalog through one insert-on-conflict statement", async () => {
    const db = await createTestDb();
    await db.insert(organization).values({
      id: "org-catalog",
      name: "Catalog",
      slug: "catalog",
    });
    const firstAt = new Date("2026-09-11T10:00:00.000Z");
    const secondAt = new Date("2026-09-11T10:01:00.000Z");

    await upsertHarnessCapabilityCatalog(db, {
      organizationId: "org-catalog",
      provider: "codex",
      cliVersion: "0.144.6",
      catalog: catalog("gpt-first"),
      catalogHash: "first",
      now: firstAt,
    });
    const updated = await upsertHarnessCapabilityCatalog(db, {
      organizationId: "org-catalog",
      provider: "codex",
      cliVersion: "0.144.6",
      catalog: catalog("gpt-second"),
      catalogHash: "second",
      now: secondAt,
    });

    expect(updated).toMatchObject({ catalogHash: "second", fetchedAt: secondAt });
    expect(updated.catalog.models[0]?.id).toBe("gpt-second");
    await expect(db.select().from(harnessCapabilityCatalogs)).resolves.toHaveLength(1);
  });
});
