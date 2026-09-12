import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

// Restated rather than imported from @shared/contracts: a block manifest is
// parsed by the catalog generator, which allows runtime values from zod only
// (scripts/gates/generate-block-catalog/manifest-imports.ts). The shared
// declaration the workflow definition schema uses is
// packages/contracts/repository-script-group.ts and the two must agree.
const repositoryScriptGroupNameSchema = z
  .string()
  .max(40, "group name must be at most 40 characters")
  .regex(
    /^[a-z][a-z0-9-]*$/u,
    "group name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens",
  );

const paramsSchema = z
  .object({ groups: z.array(repositoryScriptGroupNameSchema).min(1) })
  .strict();


export const manifest = {
  type: "run_scripts",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "utility",
    label: "Run scripts",
    description: "Runs named repository script groups in the run workspace. ok means nothing failed, while allPassed additionally requires that a selected group actually ran and passed.",
    glyph: "❯",
    color: "#64748B",
    softColor: "#EEF1F5",
  },
  defaults: { groups: ["checks"] },
  inputs: {},
  execution: "map",
} satisfies BlockManifest;
