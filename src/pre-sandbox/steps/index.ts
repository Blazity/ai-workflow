import { judgeTicketSizeStep } from "./judge-ticket-size.js";
import type { PreSandboxStepRegistry } from "../types.js";

export const preSandboxStepRegistry = {
  "judge-ticket-size": judgeTicketSizeStep,
} satisfies PreSandboxStepRegistry;

export type PreSandboxStepId = keyof typeof preSandboxStepRegistry;
