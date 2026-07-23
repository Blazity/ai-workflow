import type {
  AgentProtocolDiagnostic,
  AgentProtocolFailureCategory,
} from "./types.js";

/**
 * Agent runtime failure carried across the step boundary. Lives in its own
 * module with type-only imports so workflow-context code (non-step) can import
 * it without dragging protocol.ts, whose module scope touches node:crypto and
 * the pino logger, into the workflow bundle. The workflow bundler rejects
 * Node.js modules in workflow functions, so protocol.ts must stay step-only.
 */
export class AgentRuntimeError extends Error {
  readonly category: AgentProtocolFailureCategory;
  readonly safeMessage: string;
  readonly diagnostic: AgentProtocolDiagnostic;

  constructor(input: {
    category: AgentProtocolFailureCategory;
    message: string;
    diagnostic: AgentProtocolDiagnostic;
  }) {
    super(input.message);
    this.name = "AgentRuntimeError";
    this.category = input.category;
    this.safeMessage = input.message;
    this.diagnostic = input.diagnostic;
  }
}

export function isAgentRuntimeError(error: unknown): error is AgentRuntimeError {
  return error instanceof AgentRuntimeError;
}
