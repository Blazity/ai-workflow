import { repoSelectionStep } from "./repo-selection.js";
// Engine-owned pre-sandbox step registry.
import type { PreSandboxStepRegistry } from "../types.js";

export const preSandboxStepRegistry = {
  "repo-selection": repoSelectionStep,
} satisfies PreSandboxStepRegistry;

export type PreSandboxStepId = keyof typeof preSandboxStepRegistry;
