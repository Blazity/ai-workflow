import type { PreSandboxStepRegistry } from "../types.js";

export const preSandboxStepRegistry = {} satisfies PreSandboxStepRegistry;

export type PreSandboxStepId = keyof typeof preSandboxStepRegistry;
