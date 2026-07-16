/**
 * Payload of the pull request that fired a PR-based trigger. Assembled by the
 * webhook dispatch layer and carried unchanged through the run so block
 * executors can read PR facts without re-fetching them.
 */
export interface PrTriggerPayload {
  provider: "github" | "gitlab";
  repoPath: string;
  prNumber: number;
  prUrl: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  title: string;
  author: string;
  isDraft: boolean;
  failedChecks?: Array<{ name: string; conclusion: string; detailsUrl?: string }>;
  review?: { state: "changes_requested" | "commented"; author: string; body: string };
}

/**
 * Entry describing what started an agent workflow run. "ticket" is the classic
 * ticket-column trigger, "pr_trigger" covers the PR webhook triggers,
 * "plan_approved" resumes a run after a human approved a plan on the dashboard,
 * and "clarification_answered" resumes a run after a human answered the
 * questions the agent parked on.
 */
export type AgentWorkflowInput =
  | { kind: "ticket"; ticketKey: string; definitionId?: number }
  | {
      kind: "pr_trigger";
      triggerType: "trigger_pr_created" | "trigger_pr_checks_failed" | "trigger_pr_review";
      ticketKey: string;
      definitionId: number;
      pr: PrTriggerPayload;
    }
  | {
      kind: "plan_approved";
      ticketKey: string;
      definitionId: number;
      /** Pinned definition version that produced the approved plan. When set, the
       *  run loads exactly that version instead of the definition's head. */
      definitionVersion?: number;
      approvedPlan: { markdown: string; assumptions?: string[] };
      approval: { approvalRequestId: string; approver: string; approvedAt: string };
    }
  | {
      kind: "clarification_answered";
      ticketKey: string;
      definitionId?: number;
      /** Clarification request whose answer resumes work on the ticket. */
      clarificationRequestId: string;
    };
