import { ticketComplexityCheckStep } from "./ticket-complexity-check.js";
import type { PreSandboxStepRegistry } from "../types.js";

export const preSandboxStepRegistry = {
  "ticket-complexity-check": ticketComplexityCheckStep,
} satisfies PreSandboxStepRegistry;

export type PreSandboxStepId = keyof typeof preSandboxStepRegistry;
