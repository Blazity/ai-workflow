import type {
  PreSandboxConfig,
  PreSandboxConfigStep,
  PreSandboxPromptAddition,
  PreSandboxPromptAdditionsByTarget,
  PreSandboxStepContext,
  PreSandboxStepRegistry,
  RunPreSandboxPhaseInput,
  RunPreSandboxPhaseResult,
} from "./types.js";
import { preSandboxTicketInputFields } from "./types.js";

interface PreSandboxLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export async function runPreSandboxPhase(
  input: RunPreSandboxPhaseInput,
): Promise<RunPreSandboxPhaseResult> {
  "use step";
  const { loadPreSandboxConfig } = await import("./config.js");
  const { preSandboxStepRegistry } = await import("./steps/index.js");
  const { logger } = await import("../lib/logger.js");

  return executePreSandboxPhase(input, loadPreSandboxConfig(), preSandboxStepRegistry, logger);
}
runPreSandboxPhase.maxRetries = 0;

export async function executePreSandboxPhase(
  input: RunPreSandboxPhaseInput,
  config: PreSandboxConfig,
  registry: PreSandboxStepRegistry,
  logger?: PreSandboxLogger,
): Promise<RunPreSandboxPhaseResult> {
  const promptAdditions = emptyPromptAdditions();
  let selectedRepositories: RunPreSandboxPhaseResult["selectedRepositories"];

  for (const step of config.preSandbox.steps) {
    const handler = registry[step.uses];
    if (!handler) {
      return {
        status: "halt",
        outcome: "failed",
        message: `Pre-sandbox step "${step.uses}" is not registered.`,
        promptAdditions,
      };
    }

    const displayName = step.name ?? step.uses;
    try {
      const result = await withTimeout(
        handler({
          context: {
            ticket: selectTicketFields(input.ticket, step),
            run: input.run,
          },
          config: step.with,
          step,
        }),
        step.timeoutMs,
        displayName,
      );

      if (result.promptAdditions) {
        addPromptAdditions(promptAdditions, result.promptAdditions);
      }
      if (result.selectedRepositories) {
        selectedRepositories = result.selectedRepositories;
      }

      if (result.status === "halt") {
        return {
          status: "halt",
          outcome: result.outcome,
          message: result.message,
          questions: result.questions,
          promptAdditions,
          selectedRepositories,
        };
      }
    } catch (err) {
      const message = failureMessage(step, err);
      if (step.onFailure === "continue") {
        logger?.warn({ step: displayName, err: errorMessage(err) }, "pre_sandbox_step_failed");
        continue;
      }

      return {
        status: "halt",
        outcome: "failed",
        message,
        promptAdditions,
      };
    }
  }

  return { status: "continue", promptAdditions, selectedRepositories };
}

function selectTicketFields(
  ticket: RunPreSandboxPhaseInput["ticket"],
  step: PreSandboxConfigStep,
): PreSandboxStepContext["ticket"] {
  const selectedFields = selectedTicketFields(step.with);
  const selectedTicket: PreSandboxStepContext["ticket"] = {};

  for (const field of selectedFields) {
    if (field === "identifier" && ticket.identifier !== undefined) {
      selectedTicket.identifier = ticket.identifier;
    } else if (field === "title" && ticket.title !== undefined) {
      selectedTicket.title = ticket.title;
    } else if (field === "description" && ticket.description !== undefined) {
      selectedTicket.description = ticket.description;
    } else if (field === "acceptanceCriteria" && ticket.acceptanceCriteria !== undefined) {
      selectedTicket.acceptanceCriteria = ticket.acceptanceCriteria;
    } else if (field === "comments" && ticket.comments !== undefined) {
      selectedTicket.comments = ticket.comments;
    } else if (field === "labels" && ticket.labels !== undefined) {
      selectedTicket.labels = ticket.labels;
    }
  }

  return selectedTicket;
}

function selectedTicketFields(config: unknown): typeof preSandboxTicketInputFields[number][] {
  if (!isRecord(config)) {
    return [...preSandboxTicketInputFields];
  }

  const inputConfig = config.input;
  if (!isRecord(inputConfig)) {
    return [...preSandboxTicketInputFields];
  }

  const ticketFields = inputConfig.ticket;
  if (!Array.isArray(ticketFields)) {
    return [...preSandboxTicketInputFields];
  }

  return preSandboxTicketInputFields.filter((field) => ticketFields.includes(field));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  stepName: string,
): Promise<T> {
  if (timeoutMs === undefined) return promise;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Pre-sandbox step "${stepName}" timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function failureMessage(step: PreSandboxConfigStep, err: unknown): string {
  const displayName = step.name ?? step.uses;
  const details = errorMessage(err);

  if (step.onFailure === "move_to_backlog") {
    return `Pre-sandbox rejected the ticket in "${displayName}": ${details}`;
  }

  return `Pre-sandbox step "${displayName}" failed: ${details}`;
}

function addPromptAdditions(
  grouped: PreSandboxPromptAdditionsByTarget,
  additions: PreSandboxPromptAddition[],
): void {
  for (const addition of additions) {
    for (const target of addition.target) {
      grouped[target].push(addition);
    }
  }
}

function emptyPromptAdditions(): PreSandboxPromptAdditionsByTarget {
  return {
    research: [],
    implementation: [],
    review: [],
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
