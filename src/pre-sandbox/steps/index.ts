import { requireTitleLengthStep } from "./require-title-length.js";
import type { PreSandboxStepRegistry } from "../types.js";

export const preSandboxStepRegistry = {
  "require-title-length": requireTitleLengthStep,
} satisfies PreSandboxStepRegistry;

export type PreSandboxStepId = keyof typeof preSandboxStepRegistry;
