import { repoSelectionStep } from "./repo-selection.js";
import type { PreSandboxStepRegistry } from "../types.js";

export const preSandboxStepRegistry = {
  "repo-selection": repoSelectionStep,
} satisfies PreSandboxStepRegistry;

export type PreSandboxStepId = keyof typeof preSandboxStepRegistry;
