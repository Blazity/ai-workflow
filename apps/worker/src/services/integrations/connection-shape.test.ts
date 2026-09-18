import { integrationManifests } from "@integrations/registry";
import { describe, expect, it } from "vitest";

/**
 * The connection shape of every integration this build ships, committed.
 *
 * A run pins the values of the fields below, so changing one of them moves the
 * fingerprint on every deployment that sets it and stops every run in flight
 * through that integration with `reconfigured`. That is the same class of change
 * as moving a `"use step"` file, and it needs the same treatment: drain
 * production and demo before the merge.
 *
 * The problem this solves is that such a change is invisible. Renaming a field
 * key, pointing it at a different variable or changing a default is a one-line
 * edit inside an integration package, and nothing in a diff says a run will die
 * of it. So the shape is a committed artefact: the edit and its consequence
 * arrive in the same review, and a reviewer who sees this file move asks for the
 * drain line.
 *
 * Only what the fingerprint reads is here. A label, a description or a docs URL
 * can change freely.
 *
 * WHEN THIS FAILS: regenerate it with `pnpm vitest run
 * src/services/integrations/connection-shape.test.ts -u`, and add the drain to
 * the stage's definition of done, naming the integrations whose shape moved.
 */
describe("the connection shape a run pins", () => {
  it("has not changed without somebody saying so", async () => {
    const shape = integrationManifests.map((manifest) => ({
      integration: manifest.id,
      fields: [...manifest.connection.fields]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((field) => ({
          key: field.key,
          env: field.env,
          secret: field.secret,
          // Only a secret marked this way reaches the pin, so the flag itself is
          // part of the shape: turning it on starts stopping runs on rotation,
          // and turning it off stops catching an account swap.
          identity: field.identity === true,
          optional: field.optional === true,
          default: field.default ?? null,
          format: field.format ?? "text",
        })),
    }));
    await expect(`${JSON.stringify(shape, null, 2)}\n`).toMatchFileSnapshot(
      "./connection-shape.snapshot.json",
    );
  });
});
