import type {
  AgentProtocolDiagnostic,
  AgentProtocolFailureCategory,
} from "./types.js";

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
