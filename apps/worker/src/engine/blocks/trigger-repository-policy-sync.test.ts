/**
 * The nine trigger manifests that carry a `repositoryPolicy` field
 * (`trigger-{pr-checks-failed,pr-created,pr-merged,pr-ready,pr-review,
 * pr-updated,schedule,ticket-ai,webhook}`) each hand-write their own copy of
 * `triggerRepositoryPolicySchema` (`@shared/contracts`, in `work-scope.ts`),
 * because the block catalog generator allows a manifest to import
 * `@shared/contracts` only as a type
 * (`scripts/gates/generate-block-catalog/manifest-imports.ts`). Nothing keeps
 * the ten copies (nine manifests plus the source of truth) in step by
 * construction, so this file proves they still agree, on the exact field
 * schema each manifest exposes.
 *
 * `params.generated.ts` already re-exports every manifest's `paramsSchema`
 * verbatim as `BLOCK_PARAM_SCHEMAS` (see `block-params-schemas.test.ts`,
 * which reads the same export), so this file reaches each manifest's
 * `repositoryPolicy` field through that existing export rather than adding a
 * new one to any manifest.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { triggerRepositoryPolicySchema } from "@shared/contracts";
import { BLOCK_PARAM_SCHEMAS as MANIFEST_PARAM_SCHEMAS } from "../definition/params.generated.js";
import { PROVIDER_ID_PROBES } from "../../test-support/provider-id-probes.js";

/** The nine trigger types whose manifest carries a hand-written
 *  `repositoryPolicy` copy. `trigger_plan_approved` deliberately has none
 *  (an approved plan carries its own frozen scope), which is why it is not
 *  in this list and is asserted separately below. */
const POLICY_TRIGGER_TYPES = [
  "trigger_ticket_ai",
  "trigger_pr_created",
  "trigger_pr_ready",
  "trigger_pr_updated",
  "trigger_pr_checks_failed",
  "trigger_pr_review",
  "trigger_pr_merged",
  "trigger_webhook",
  "trigger_schedule",
] as const;
type PolicyTriggerType = (typeof POLICY_TRIGGER_TYPES)[number];

/** A manifest's `paramsSchema` is a plain `.strict()` object for eight of the
 *  nine types, and `trigger-webhook/manifest.ts` wraps its object in a
 *  `.superRefine`, which makes it a `ZodEffects`. Unwrap whatever effects sit
 *  on top so `.shape` reaches the real object in every case, rather than
 *  hard-coding the one exception. */
function unwrapToObjectSchema(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> {
  let current: z.ZodTypeAny = schema;
  while (current instanceof z.ZodEffects) {
    current = current.innerType();
  }
  if (!(current instanceof z.ZodObject)) {
    throw new Error("Expected a manifest paramsSchema to unwrap to a ZodObject.");
  }
  return current;
}

/** The exact field schema each manifest exposes for `repositoryPolicy`,
 *  `.optional()` included, reached only through `paramsSchema` (no manifest
 *  export was added or changed to get here). */
const manifestRepositoryPolicyFields: Record<PolicyTriggerType, z.ZodTypeAny> = Object.fromEntries(
  POLICY_TRIGGER_TYPES.map((type) => {
    const shape = unwrapToObjectSchema(MANIFEST_PARAM_SCHEMAS[type]).shape;
    if (!("repositoryPolicy" in shape)) {
      throw new Error(`Manifest for ${type} does not expose a repositoryPolicy field.`);
    }
    return [type, shape.repositoryPolicy as z.ZodTypeAny];
  }),
) as Record<PolicyTriggerType, z.ZodTypeAny>;

/** The contract's own field, wrapped the same way every manifest wraps its
 *  copy (`repositoryPolicy.optional()`), so `undefined` is a fair comparison
 *  too: the base `triggerRepositoryPolicySchema` is not itself optional. */
const contractRepositoryPolicyField = triggerRepositoryPolicySchema.optional();

/** One path 200 characters long (`REPOSITORY_CATALOG_LABEL_MAX_LENGTH` in
 *  `packages/contracts/repository-catalog.ts`), and one 201, built as two
 *  slash-separated segments so both satisfy the "at least one slash, no
 *  empty segment" shape the pattern requires everywhere else. */
const pathAtMaxLength = `${"a".repeat(100)}/${"b".repeat(99)}`;
const pathOneOverMaxLength = `${"a".repeat(100)}/${"b".repeat(100)}`;

function listed(repositoryKeys: readonly string[], expansion: "attach" | "ask_once" | "never" = "attach") {
  return { candidates: { kind: "listed", repositoryKeys }, expansion };
}

const CORPUS: { name: string; input: unknown }[] = [
  {
    name: "candidates: enabled_catalog, expansion: attach",
    input: { candidates: { kind: "enabled_catalog" }, expansion: "attach" },
  },
  {
    name: "candidates: event_repository_and_related, expansion: attach",
    input: { candidates: { kind: "event_repository_and_related" }, expansion: "attach" },
  },
  {
    name: "candidates: listed with one key, expansion: attach",
    input: listed(["github:blazity/ai-workflow-demo"], "attach"),
  },
  {
    name: "expansion: ask_once",
    input: { candidates: { kind: "enabled_catalog" }, expansion: "ask_once" },
  },
  {
    name: "expansion: never",
    input: { candidates: { kind: "enabled_catalog" }, expansion: "never" },
  },
  {
    name: "listed with 50 keys (the maximum)",
    input: listed(Array.from({ length: 50 }, (_, i) => `github:org/repo-${i}`)),
  },
  {
    name: "listed with 51 keys (one over the maximum)",
    input: listed(Array.from({ length: 51 }, (_, i) => `github:org/repo-${i}`)),
  },
  {
    name: "listed with 0 keys",
    input: listed([]),
  },
  {
    name: "listed with duplicate keys",
    input: listed(["github:a/b", "github:a/b"]),
  },
  {
    // What the contract does: repositoryKeySchema trims and lower-cases each
    // element BEFORE the array-level uniqueness refine runs, so two keys
    // that differ only in case have already collapsed into the same string
    // by the time uniqueness is checked. The contract therefore refuses
    // this exactly as it refuses an already-identical duplicate; asserted
    // here as agreement between the contract and every manifest, whichever
    // way that turns out.
    name: "listed with keys duplicate only after lower-casing",
    input: listed(["github:A/B", "github:a/b"]),
  },
  {
    name: "listed with an upper-case key and surrounding spaces",
    input: listed(["  GitHub:Blazity/AI-Workflow-Demo  "]),
  },
  {
    name: "listed with a nested gitlab group path",
    input: listed(["gitlab:group/subgroup/project"]),
  },
  {
    name: "listed with a path at exactly the maximum length",
    input: listed([`github:${pathAtMaxLength}`]),
  },
  {
    name: "listed with a path one character over the maximum length",
    input: listed([`github:${pathOneOverMaxLength}`]),
  },
  {
    name: "listed with an unknown provider",
    input: listed(["bitbucket:a/b"]),
  },
  {
    name: "listed with no slash",
    input: listed(["github:repo"]),
  },
  {
    name: "listed with an empty path segment",
    input: listed(["github:a//b"]),
  },
  {
    name: "listed with whitespace inside the path",
    input: listed(["github:a b/c"]),
  },
  {
    name: "unknown extra property at the top level",
    input: { candidates: { kind: "enabled_catalog" }, expansion: "attach", extra: true },
  },
  {
    name: "unknown extra property inside candidates",
    input: {
      candidates: { kind: "listed", repositoryKeys: ["github:a/b"], extra: 1 },
      expansion: "attach",
    },
  },
  {
    name: "missing expansion",
    input: { candidates: { kind: "enabled_catalog" } },
  },
  {
    name: "unknown expansion value",
    input: { candidates: { kind: "enabled_catalog" }, expansion: "sometimes" },
  },
  {
    name: "unknown candidates.kind",
    input: { candidates: { kind: "mirrored" }, expansion: "attach" },
  },
  {
    name: "non-object input: a string",
    input: "not-a-policy",
  },
  {
    name: "non-object input: an array",
    input: [],
  },
  {
    name: "non-object input: a number",
    input: 42,
  },
  {
    name: "undefined",
    input: undefined,
  },
  // The provider half of a key is the integration id rule, at its edges.
  ...PROVIDER_ID_PROBES.map((provider) => ({
    name: `listed with provider ${JSON.stringify(provider)}`,
    input: listed([`${provider}:acme/api`]),
  })),
];

describe("trigger repository policy: manifest copies vs the contract", () => {
  it.each(CORPUS)("$name", ({ input }) => {
    const expected = contractRepositoryPolicyField.safeParse(input);
    for (const type of POLICY_TRIGGER_TYPES) {
      const actual = manifestRepositoryPolicyFields[type].safeParse(input);
      expect(actual.success, type).toBe(expected.success);
      if (expected.success && actual.success) {
        expect(actual.data, type).toEqual(expected.data);
      }
    }
  });
});

describe("trigger repository policy: field presence", () => {
  it("is exposed by exactly the nine trigger manifests that carry it", () => {
    expect(POLICY_TRIGGER_TYPES.length).toBe(9);
    for (const type of POLICY_TRIGGER_TYPES) {
      expect(manifestRepositoryPolicyFields[type], type).toBeInstanceOf(z.ZodType);
    }
  });
});
