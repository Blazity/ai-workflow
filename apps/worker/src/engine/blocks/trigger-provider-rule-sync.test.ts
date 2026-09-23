/**
 * The pull request trigger manifests each hand-write the provider id rule for
 * their `providers` list, because a manifest may import `@shared/contracts`
 * only as a type (`scripts/gates/generate-block-catalog/manifest-imports.ts`),
 * so the rule's one home, `INTEGRATION_ID`, cannot reach them as a value.
 * Nothing keeps those copies in step by construction; this file does, against
 * `vcsProviderSelection`, the list a stored definition is actually read with.
 * The repository key half of the same rule is held by
 * `trigger-repository-policy-sync.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { integrationsProviding } from "@integrations/registry";
import { repositoryCatalogProviderSchema } from "@shared/contracts";
import { vcsProviderSelection } from "@shared/workflow-graph";
import { BLOCK_PARAM_SCHEMAS as MANIFEST_PARAM_SCHEMAS } from "../definition/params.generated.js";
import { PROVIDER_ID_PROBES } from "../../test-support/provider-id-probes.js";

const PROVIDER_LIST_TRIGGER_TYPES = [
  "trigger_pr_created",
  "trigger_pr_ready",
  "trigger_pr_updated",
  "trigger_pr_checks_failed",
  "trigger_pr_review",
  "trigger_pr_merged",
] as const;

function providersField(type: (typeof PROVIDER_LIST_TRIGGER_TYPES)[number]): z.ZodTypeAny {
  let schema: z.ZodTypeAny = MANIFEST_PARAM_SCHEMAS[type];
  while (schema instanceof z.ZodEffects) schema = schema.innerType();
  if (!(schema instanceof z.ZodObject)) throw new Error(`${type} params are not an object`);
  const field = (schema.shape as Record<string, z.ZodTypeAny>).providers;
  if (!field) throw new Error(`${type} declares no providers list`);
  return field;
}

describe("trigger provider lists: manifest copies vs the definition reader", () => {
  it.each(PROVIDER_ID_PROBES.map((probe) => ({ probe })))("agree on $probe", ({ probe }) => {
    const expected = vcsProviderSelection.safeParse([probe]);
    for (const type of PROVIDER_LIST_TRIGGER_TYPES) {
      const actual = providersField(type).safeParse([probe]);
      expect(actual.success, type).toBe(expected.success);
      if (expected.success && actual.success) expect(actual.data, type).toEqual(expected.data);
    }
  });
});

describe("the provider rule and what this build ships", () => {
  it("accepts the id of every version control integration in the registry", () => {
    const ids = integrationsProviding("vcs").map((manifest) => manifest.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(repositoryCatalogProviderSchema.safeParse(id).success, id).toBe(true);
    }
  });
});
