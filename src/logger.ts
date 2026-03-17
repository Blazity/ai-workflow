import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  });
}

export function createTicketLogger(
  parent: Logger,
  ticketId: string,
  ticketIdentifier: string,
): Logger {
  return parent.child({ ticket_id: ticketId, ticket_identifier: ticketIdentifier });
}

export function createRunLogger(
  parent: Logger,
  runAttemptId: string,
): Logger {
  return parent.child({ run_attempt_id: runAttemptId });
}
