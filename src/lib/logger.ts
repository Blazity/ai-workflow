import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function ticketLogger(ticketId: string, identifier: string) {
  return logger.child({ ticket_id: ticketId, ticket_identifier: identifier });
}

export function workflowLogger(
  ticketId: string,
  identifier: string,
  workflowRunId: string,
) {
  return logger.child({
    ticket_id: ticketId,
    ticket_identifier: identifier,
    workflow_run_id: workflowRunId,
  });
}
