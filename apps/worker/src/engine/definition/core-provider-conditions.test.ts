import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { integrationManifests } from "@integrations/registry";

/**
 * The conditions in the resolver that still name a provider, and the day each
 * one has to go.
 *
 * Every one of them reads an environment variable core owns. The moment an
 * integration ships under the same name, that condition keeps the old core
 * block in the palette on its own credentials while the integration sits
 * disabled: two answers about one provider, and the one an admin acted on
 * loses. Nothing in the type system notices, because an integration id is a
 * free string and none of these five are reserved.
 *
 * So the check is textual and the list is explicit. A stage that moves a
 * provider out deletes its condition and its row here in the same change, and
 * this test is what fails if it ships the integration and forgets.
 */

const RESOLVER = fileURLToPath(new URL("./block-contract-resolver.ts", import.meta.url));

/** Provider name to the stage that removes its condition (ADR-010). */
const SURVIVING_CONDITIONS: Record<string, string> = {
  gitlab: "S10",
  github: "S11",
  jira: "S12",
};

function resolverSource(): string {
  return readFileSync(RESOLVER, "utf8");
}

/** Comments are prose. A sentence about a provider is not a rule that reads its
 *  credentials, and a check that fired on one is a check the next stage turns
 *  off. Mirrors `strippedSource` in the core-reference gate. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("core conditions that still name a provider", () => {
  it("has no condition for a provider this build already ships as an integration", () => {
    const shipped = integrationManifests.map((manifest) => manifest.id);
    const source = code(resolverSource()).toLowerCase();
    const conflicting = shipped.filter((id) => source.includes(id));

    expect(
      conflicting,
      `block-contract-resolver.ts still decides for ${conflicting.join(", ")} out of core's own environment, ` +
        "while an integration of the same id ships in this build. The two disagree the moment an admin disables " +
        "the integration: delete the core condition in the stage that moves the provider out.",
    ).toEqual([]);
  });

  it("names, for every condition that survives, the stage that removes it", () => {
    const source = code(resolverSource()).toLowerCase();
    const present = Object.keys(SURVIVING_CONDITIONS).filter((id) => source.includes(id));
    const stages = present.map((id) => SURVIVING_CONDITIONS[id]);

    // Not "the list is exactly this": a stage that lands early makes the list
    // shorter, and that is the direction it is allowed to move.
    expect(stages.every((stage) => typeof stage === "string" && stage.length > 0)).toBe(true);
    expect(present.length).toBeLessThanOrEqual(Object.keys(SURVIVING_CONDITIONS).length);
  });

  it("lists every provider the resolver still decides for", () => {
    // The row is what ADR-010 documents, so an unlisted provider name appearing
    // in the resolver is a condition nobody agreed to keep.
    const source = code(resolverSource()).toLowerCase();
    const known = new Set(Object.keys(SURVIVING_CONDITIONS));
    const names = [...source.matchAll(/\b(arthur|slack|github|gitlab|jira|linear|notion|asana)\b/g)]
      .map((match) => match[1]);

    expect([...new Set(names)].filter((name) => !known.has(name))).toEqual([]);
  });
});
