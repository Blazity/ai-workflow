import type { AgentWorkflowInput } from "../agent-input.js";

/**
 * Whether a run keeps a work scope record for its subject. Only finite work
 * does: a ticket, a pull request, and a webhook delivery whose endpoint
 * resolved a subject id. A schedule occurrence and a subject-less delivery get
 * a new subject key every time, so a record would be written once and never
 * read, and "ask once" would mean "ask every time".
 */
export function carriesWorkScope(input: {
  subjectKey: string;
  entryKind: AgentWorkflowInput["kind"];
  webhookSubjectResolved: boolean;
}): boolean {
  // An approved plan reads only the repository snapshot a person approved and
  // writes nothing back, or a later scope change would reach work nobody
  // approved.
  if (input.entryKind === "plan_approved") return false;
  if (input.subjectKey.startsWith("ticket:") || input.subjectKey.startsWith("pr:")) {
    return true;
  }
  if (input.subjectKey.startsWith("webhook:")) return input.webhookSubjectResolved;
  return false;
}
