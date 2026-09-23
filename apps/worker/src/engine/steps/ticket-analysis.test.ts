import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The steps that write or publish a failure text workflow scope composed.
 *
 * Workflow scope redacts with the environment's secrets alone, so a tracing
 * key an admin stored in the dashboard, echoed by an agent into its stderr,
 * reaches these steps whole. Each applies every secret the deployment knows
 * before the text leaves: to the ticket, to the run's status row, to the
 * failed-ticket mark, to the operator log. And none of them uses part of the
 * set when the whole cannot be read: a publication is not made, a row or a
 * log line keeps everything but the text.
 */
const STORED_KEY = "plainvalue4471tracer";

const mocks = vi.hoisted(() => ({
  knownSecretValues: vi.fn(),
  postComment: vi.fn(),
  markFailed: vi.fn(),
  recordStatusReason: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../services/integrations/runtime.js", () => ({
  knownSecretValues: mocks.knownSecretValues,
}));
vi.mock("../../infra/logger.js", () => ({ logger: mocks.logger }));
vi.mock("../internal/ports.js", async () => {
  const { issueTrackerIfConnected, issueTrackerOrThrow } = await import(
    "../support/connected-issue-tracker.js"
  );
  return {
    loadActiveRunOwnerPort: async () => ({ assertConnectedActiveRunOwner: async () => {} }),
    loadAdaptersPort: async () => ({
      createAdapters: async () => ({
        issueTrackerResolution: {
          ok: true,
          id: "jira",
          name: "Jira",
          adapter: { postComment: mocks.postComment },
          wiring: { projectKey: "AIW", baseUrl: "https://tracker.example" },
        },
        runRegistry: { markFailed: mocks.markFailed },
      }),
      issueTrackerIfConnected,
      issueTrackerOrThrow,
    }),
    loadRunTelemetryPort: async () => ({
      recordConnectedRunStatusReason: mocks.recordStatusReason,
    }),
  };
});

const {
  logPhaseFailure,
  logWorkflowExecutionErrorStep,
  markTicketFailed,
  postFailureReasonCommentStep,
  recordRunFailureReasonStep,
} = await import("./ticket-analysis.js");

const owner = { subjectKey: "ticket:jira:AIW-1", ownerToken: "owner-1", runId: "run-1" };
const REASON = `The agent printed ${STORED_KEY} and stopped.`;
const WITHHELD = "[withheld: the secrets to redact it with could not be read]";

function knowsTheStoredKey(): void {
  mocks.knownSecretValues.mockResolvedValue([STORED_KEY]);
}
function cannotReadTheSet(): void {
  mocks.knownSecretValues.mockRejectedValue(new Error("settings unreadable"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.postComment.mockResolvedValue(null);
});

describe("the failure reason on the ticket", () => {
  it("is posted without any secret the deployment knows", async () => {
    knowsTheStoredKey();

    await postFailureReasonCommentStep("AIW-1", REASON, owner);

    const [, posted] = mocks.postComment.mock.calls[0] as [string, string];
    expect(posted).not.toContain(STORED_KEY);
    expect(posted).toContain("The agent printed");
  });

  it("is not posted at all when the set cannot be read", async () => {
    cannotReadTheSet();

    await postFailureReasonCommentStep("AIW-1", REASON, owner);

    expect(mocks.postComment).not.toHaveBeenCalled();
  });
});

describe("the failure reason on the run's status row", () => {
  it("is recorded without any secret the deployment knows", async () => {
    knowsTheStoredKey();

    await recordRunFailureReasonStep("run-1", REASON);

    const [, recorded] = mocks.recordStatusReason.mock.calls[0] as [string, string];
    expect(recorded).not.toContain(STORED_KEY);
  });

  it("is not recorded with part of the set", async () => {
    cannotReadTheSet();

    await recordRunFailureReasonStep("run-1", REASON);

    expect(mocks.recordStatusReason).not.toHaveBeenCalled();
  });
});

describe("the failed-ticket mark", () => {
  it("carries the error without any secret the deployment knows", async () => {
    knowsTheStoredKey();

    await markTicketFailed("AIW-1", "run-1", REASON, owner);

    const [, meta] = mocks.markFailed.mock.calls[0] as [string, { error: string }];
    expect(meta.error).not.toContain(STORED_KEY);
  });

  it("is still written when the set cannot be read, with the text withheld", async () => {
    // The mark is what keeps the ticket from being dispatched again.
    cannotReadTheSet();

    await markTicketFailed("AIW-1", "run-1", REASON, owner);

    const [, meta] = mocks.markFailed.mock.calls[0] as [string, { error: string; runId: string }];
    expect(meta).toMatchObject({ runId: "run-1", error: WITHHELD });
  });
});

describe("the operator log", () => {
  it("names a phase failure without any secret the deployment knows", async () => {
    knowsTheStoredKey();

    await logPhaseFailure("AIW-1", "impl", REASON);

    const [fields] = mocks.logger.warn.mock.calls[0] as [{ reason: string }];
    expect(fields.reason).not.toContain(STORED_KEY);
  });

  it("withholds a phase failure's text when the set cannot be read", async () => {
    cannotReadTheSet();

    await logPhaseFailure("AIW-1", "impl", REASON);

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ticketKey: "AIW-1", phase: "impl", reason: WITHHELD }),
      "agent_phase_failed",
    );
  });

  it("keeps an execution error's correlation fields and withholds its texts", async () => {
    cannotReadTheSet();

    await logWorkflowExecutionErrorStep({
      diagnosticId: "diag-1",
      nodeId: "impl",
      attempt: 1,
      category: "sandbox",
      detail: REASON,
      message: REASON,
    });

    expect(mocks.logger.error).toHaveBeenCalledWith(
      { diagnosticId: "diag-1", nodeId: "impl", attempt: 1, category: "sandbox", detail: WITHHELD, message: WITHHELD },
      "workflow_execution_error",
    );
  });

  it("redacts an execution error's detail with the whole set", async () => {
    knowsTheStoredKey();

    await logWorkflowExecutionErrorStep({
      diagnosticId: "diag-1",
      nodeId: "impl",
      attempt: 1,
      category: "sandbox",
      detail: REASON,
    });

    const [event] = mocks.logger.error.mock.calls[0] as [{ detail: string }];
    expect(event.detail).not.toContain(STORED_KEY);
  });
});
